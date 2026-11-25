-- Read one visible table and its dependent metadata in a single catalog query.
SELECT CASE WHEN DATALENGTH(payload.body) <= @P2 THEN payload.body END,
       DATALENGTH(payload.body)
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
LEFT JOIN sys.indexes AS base ON base.object_id = t.object_id AND base.index_id IN (0, 1)
LEFT JOIN sys.data_spaces AS base_space ON base_space.data_space_id = base.data_space_id
LEFT JOIN sys.data_spaces AS lob_space ON lob_space.data_space_id = t.lob_data_space_id
LEFT JOIN sys.partitions AS heap ON heap.object_id = t.object_id AND heap.index_id = 0 AND heap.partition_number = 1
CROSS APPLY (
    SELECT (
        SELECT s.name AS [schema], t.name AS name, base_space.name AS filegroup,
               RTRIM(base_space.type) AS storage_kind, lob_space.name AS lob_filegroup,
               heap.data_compression_desc AS heap_compression,
               JSON_QUERY((SELECT t.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)) AS flags,
               JSON_QUERY((
                   SELECT c.name, ty.name AS type_name, tys.name AS type_schema, ty.is_user_defined AS user_defined,
                          c.max_length AS [length], c.precision, c.scale, c.collation_name AS collation,
                          c.is_nullable AS nullable, c.is_identity AS [identity], c.is_computed AS computed,
                          c.is_rowguidcol AS rowguid, c.is_sparse AS sparse, c.is_column_set AS column_set,
                          c.is_hidden AS hidden, c.is_filestream AS filestream, c.generated_always_type AS generated,
                          c.encryption_type AS encryption, c.rule_object_id AS bound_rule,
                          c.is_masked AS masked, mask.masking_function AS masking_function,
                          CONVERT(nvarchar(48), ic.seed_value) AS seed,
                          CONVERT(nvarchar(48), ic.increment_value) AS increment,
                          ic.is_not_for_replication AS identity_not_for_replication,
                          cc.definition AS calculation, cc.is_persisted AS persisted,
                          c.default_object_id AS [default_id], dc.name AS [default_name], dc.definition AS [default_expression],
                          c.xml_collection_id, xc.name AS xml_collection, xs.name AS xml_schema, c.is_xml_document AS xml_document
                   FROM sys.columns AS c
                   LEFT JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
                   LEFT JOIN sys.schemas AS tys ON tys.schema_id = ty.schema_id
                   LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                   LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
                   LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id
                   LEFT JOIN sys.masked_columns AS mask ON mask.object_id = c.object_id AND mask.column_id = c.column_id
                   LEFT JOIN sys.xml_schema_collections AS xc ON xc.xml_collection_id = c.xml_collection_id
                   LEFT JOIN sys.schemas AS xs ON xs.schema_id = xc.schema_id
                   WHERE c.object_id = t.object_id ORDER BY c.column_id FOR JSON PATH
               )) AS columns,
               JSON_QUERY((
                   SELECT c.name, c.definition AS expression, c.is_disabled AS disabled,
                          c.is_not_trusted AS untrusted, c.is_not_for_replication AS not_for_replication
                   FROM sys.check_constraints AS c
                   WHERE c.parent_object_id = t.object_id ORDER BY c.object_id FOR JSON PATH
               )) AS checks,
               JSON_QUERY((
                   SELECT i.name, i.type AS index_type, i.type_desc AS method, i.is_unique AS [unique],
                          CAST(CASE WHEN i.is_primary_key = 1 OR i.is_unique_constraint = 1 THEN 1 ELSE 0 END AS bit) AS has_constraint,
                          k.name AS constraint_name, RTRIM(k.type) AS constraint_kind, i.is_disabled AS disabled,
                          i.is_hypothetical AS hypothetical, i.has_filter, i.filter_definition AS filter,
                          ds.name AS filegroup, RTRIM(ds.type) AS storage_kind, p.data_compression_desc AS compression,
                          i.fill_factor, i.is_padded AS padded, i.ignore_dup_key AS ignore_duplicates,
                          i.allow_row_locks, i.allow_page_locks,
                          JSON_QUERY((
                              SELECT c.name, ic.key_ordinal AS key_position, ic.is_descending_key AS descending,
                                     ic.is_included_column AS included
                              FROM sys.index_columns AS ic
                              JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                              ORDER BY CASE WHEN ic.key_ordinal = 0 THEN 1 ELSE 0 END, ic.key_ordinal, ic.index_column_id
                              FOR JSON PATH
                          )) AS columns
                   FROM sys.indexes AS i
                   LEFT JOIN sys.key_constraints AS k ON k.parent_object_id = i.object_id AND k.unique_index_id = i.index_id
                   LEFT JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id
                   LEFT JOIN sys.partitions AS p ON p.object_id = i.object_id AND p.index_id = i.index_id AND p.partition_number = 1
                   WHERE i.object_id = t.object_id AND i.index_id > 0 ORDER BY i.index_id FOR JSON PATH
               )) AS indexes,
               JSON_QUERY((
                   SELECT f.name, rs.name AS target_schema, rt.name AS target_table,
                          f.update_referential_action AS on_update, f.delete_referential_action AS on_delete,
                          f.is_disabled AS disabled, f.is_not_trusted AS untrusted,
                          f.is_not_for_replication AS not_for_replication,
                          JSON_QUERY((
                              SELECT sc.name AS source, rc.name AS target
                              FROM sys.foreign_key_columns AS fc
                              LEFT JOIN sys.columns AS sc ON sc.object_id = f.parent_object_id AND sc.column_id = fc.parent_column_id
                              LEFT JOIN sys.columns AS rc ON rc.object_id = rt.object_id AND rc.column_id = fc.referenced_column_id
                              WHERE fc.constraint_object_id = f.object_id ORDER BY fc.constraint_column_id FOR JSON PATH
                          )) AS columns
                   FROM sys.foreign_keys AS f
                   LEFT JOIN sys.tables AS rt ON rt.object_id = f.referenced_object_id
                   LEFT JOIN sys.schemas AS rs ON rs.schema_id = rt.schema_id
                   WHERE f.parent_object_id = t.object_id ORDER BY f.object_id FOR JSON PATH
               )) AS foreign_keys
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS body
) AS payload
WHERE t.object_id = @P1 AND t.is_ms_shipped = 0
  AND HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(t.name), 'OBJECT', 'VIEW DEFINITION') = 1;
