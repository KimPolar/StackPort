const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Connection, Request } = require(process.env.STACKPORT_TEDIOUS_PATH || 'tedious');

async function seedSqlServer({ port, ca, database, account, password }) {
  assert.match(database, /^StackPortFixture_[a-f0-9]{12}$/);
  assert.match(account, /^stackport_catalog_[a-f0-9]{12}$/);
  assert.match(password, /^[a-zA-Z0-9!-]+$/);
  const adminPassword = process.env.STACKPORT_SQL_SERVER_SA_PASSWORD;
  assert.ok(adminPassword, 'Provide the isolated SQL Server fixture administrator password.');
  const connection = new Connection({
    server: 'localhost',
    authentication: { type: 'default', options: { userName: 'sa', password: adminPassword } },
    options: {
      port, database: 'master', encrypt: true, trustServerCertificate: false,
      cryptoCredentialsDetails: { ca: fs.readFileSync(ca) }, connectTimeout: 5000, requestTimeout: 30_000,
      rowCollectionOnRequestCompletion: true,
    },
  });
  function execute(sql) {
    return new Promise((resolve, reject) => {
      const request = new Request(sql, (error, _count, rows) => error ? reject(error) : resolve(rows));
      connection.execSqlBatch(request);
    });
  }

  try {
    await new Promise((resolve, reject) => connection.connect(error => error ? reject(error) : resolve()));
    await execute(`CREATE DATABASE [${database}]`);
    await execute(`CREATE LOGIN [${account}] WITH PASSWORD=N'${password}', CHECK_POLICY=OFF`);
    await execute(`USE [${database}]`);
    await execute('CREATE SCHEMA [catalog]');
    await execute('CREATE SCHEMA [archive]');
    await execute('CREATE SCHEMA [private]');
    await execute(`
CREATE TABLE [private].[hidden_data] (id int NOT NULL PRIMARY KEY, [%_literal] int);
CREATE TABLE [catalog].[metadata_only] (id int NOT NULL);
CREATE TABLE [archive].[order]]daily] ([%_literal] int, [%Xliteral] int);
CREATE TABLE [archive].[wildcard_decoy] ([%Xliteral] int);
CREATE TABLE [archive].[accounts] (tenant int NOT NULL, account bigint NOT NULL, PRIMARY KEY (tenant, account));
CREATE TABLE [archive].[unique_disabled] (token int NOT NULL CONSTRAINT [uq_disabled_token] UNIQUE);
ALTER INDEX [uq_disabled_token] ON [archive].[unique_disabled] DISABLE;
CREATE TABLE [archive].[analytics_fixture] (event_id int, amount decimal(18,2));
CREATE CLUSTERED COLUMNSTORE INDEX [cci_analytics] ON [archive].[analytics_fixture];
CREATE TABLE [catalog].[order]]daily] (
    id bigint NOT NULL,
    seq int IDENTITY(1,1) NOT NULL,
    exact_value decimal(30,6) NOT NULL,
    payload varbinary(max) NULL,
    title nvarchar(max) NULL,
    logged_at datetime2(6) NOT NULL,
    account_region int NULL,
    account_id bigint NULL,
    private_id int NULL,
    related_id bigint NULL,
    related_seq int NULL,
    badge tinyint NOT NULL CONSTRAINT [df_fixture_badge] DEFAULT ((7)),
    CONSTRAINT [fixture_pk] PRIMARY KEY (id DESC, seq),
    CONSTRAINT [uq_fixture_seq] UNIQUE (seq),
    CONSTRAINT [ck_fixture_amount] CHECK (exact_value >= 0)
);
DECLARE @i int = 0;
WHILE @i < 61
BEGIN
    INSERT [catalog].[order]]daily] (id, exact_value, payload, title, logged_at)
    VALUES (9223372036854775807 - CONVERT(bigint, @i), 123456789012345678901234.567890,
        CASE WHEN @i = 0 THEN 0x00FF11 ELSE NULL END,
        CASE WHEN @i = 0 THEN REPLICATE(CONVERT(nvarchar(max), NCHAR(0xd55c)), 255) + CONVERT(nvarchar(2), 0x3dd880de) + N'next'
             ELSE N'row ' + CONVERT(nvarchar(10), @i) END,
        '2026-09-18T04:12:33.123456');
    SET @i += 1;
END;
ALTER TABLE [catalog].[order]]daily] NOCHECK CONSTRAINT [ck_fixture_amount];
ALTER TABLE [catalog].[order]]daily] ADD CONSTRAINT [fk_fixture_account]
    FOREIGN KEY (account_region, account_id) REFERENCES [archive].[accounts] (tenant, account)
    ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE [catalog].[order]]daily] ADD CONSTRAINT [fk_fixture_private]
    FOREIGN KEY (private_id) REFERENCES [private].[hidden_data] (id);
ALTER TABLE [catalog].[order]]daily] ADD CONSTRAINT [fk_fixture_self]
    FOREIGN KEY (related_id, related_seq) REFERENCES [catalog].[order]]daily] (id, seq);
CREATE TABLE [archive].[order_detail] (
    base_id bigint, base_seq int, CONSTRAINT [fk_detail_order] FOREIGN KEY (base_id, base_seq)
    REFERENCES [catalog].[order]]daily] (id, seq));
CREATE TABLE [private].[hidden_order_detail] (
    base_id bigint, base_seq int, CONSTRAINT [fk_hidden_incoming] FOREIGN KEY (base_id, base_seq)
    REFERENCES [catalog].[order]]daily] (id, seq));
CREATE INDEX [ix_fixture_filter] ON [catalog].[order]]daily] (exact_value DESC, logged_at)
    INCLUDE (seq, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX [ix_fixture_disabled] ON [catalog].[order]]daily] (account_region);
ALTER INDEX [ix_fixture_disabled] ON [catalog].[order]]daily] DISABLE;
`);
    await execute('CREATE VIEW [catalog].[recent] AS\r\nSELECT id, seq, exact_value FROM [catalog].[order]]daily] WHERE seq <= 2\r\n-- 한글 정의');
    await execute('CREATE VIEW [archive].[sealed_report] WITH ENCRYPTION AS SELECT 1 AS id');
    await execute(`
DECLARE @i int = 1;
WHILE @i <= 51
BEGIN
    DECLARE @name nvarchar(128) = N'report_' + RIGHT(N'00' + CONVERT(nvarchar(2), @i), 2);
    DECLARE @ddl nvarchar(max) = N'CREATE VIEW [archive].' + QUOTENAME(@name) + N' AS SELECT 2 AS match_a, 3 AS match_b';
    EXEC sys.sp_executesql @ddl;
    DECLARE @check nvarchar(128) = N'check_' + RIGHT(N'00' + CONVERT(nvarchar(2), @i), 2);
    SET @ddl = N'ALTER TABLE [catalog].[metadata_only] ADD CONSTRAINT ' + QUOTENAME(@check) + N' CHECK (id >= 0)';
    EXEC sys.sp_executesql @ddl;
    SET @i += 1;
END;
`);
    await execute(`
CREATE USER [${account}] FOR LOGIN [${account}];
GRANT SELECT ON SCHEMA::[archive] TO [${account}];
GRANT SELECT ON [catalog].[order]]daily] TO [${account}];
GRANT VIEW DEFINITION ON [catalog].[order]]daily] TO [${account}];
GRANT SELECT ON [catalog].[recent] TO [${account}];
GRANT VIEW DEFINITION ON [catalog].[recent] TO [${account}];
GRANT VIEW DEFINITION ON [archive].[sealed_report] TO [${account}];
GRANT VIEW DEFINITION ON [catalog].[metadata_only] TO [${account}];
`);
    const rows = await execute("SELECT OBJECT_ID(N'private.hidden_data')");
    return rows[0][0].value;
  } finally { connection.close(); }
}

module.exports = { seedSqlServer };
