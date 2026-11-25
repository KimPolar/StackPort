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
    await execute('CREATE SCHEMA [private]');
    await execute(`
CREATE TABLE [private].[hidden_data] (id int NOT NULL);
CREATE TABLE [catalog].[metadata_only] (id int NOT NULL);
CREATE TABLE [catalog].[order]]daily] (
    id bigint NOT NULL,
    seq int IDENTITY(1,1) NOT NULL,
    exact_value decimal(30,6) NOT NULL,
    payload varbinary(max) NULL,
    title nvarchar(max) NULL,
    logged_at datetime2(6) NOT NULL,
    CONSTRAINT [fixture_pk] PRIMARY KEY (id DESC, seq)
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
`);
    await execute('CREATE VIEW [catalog].[recent] AS SELECT id, seq, exact_value FROM [catalog].[order]]daily] WHERE seq <= 2');
    await execute(`
CREATE USER [${account}] FOR LOGIN [${account}];
GRANT SELECT ON [catalog].[order]]daily] TO [${account}];
GRANT SELECT ON [catalog].[recent] TO [${account}];
GRANT VIEW DEFINITION ON [catalog].[metadata_only] TO [${account}];
`);
    const rows = await execute("SELECT OBJECT_ID(N'private.hidden_data')");
    return rows[0][0].value;
  } finally { connection.close(); }
}

module.exports = { seedSqlServer };
