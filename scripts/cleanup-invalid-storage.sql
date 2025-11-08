-- Cleanup script for PostgresKeyValueStorage invalid data
-- This script removes corrupted '[object Object]' entries from key-value storage tables

-- Remove invalid entries from internal_kv table (default table name)
DELETE FROM internal_kv 
WHERE value = '[object Object]' 
   OR value = '"[object Object]"'
   OR value = 'undefined'
   OR value = 'null'
   OR value = '';

-- Check for any remaining invalid JSON entries
SELECT 
    key, 
    value,
    length(value) as value_length
FROM internal_kv 
WHERE value !~ '^[\[\{].*[\]\}]$' 
  AND value !~ '^".*"$' 
  AND value !~ '^(true|false|null|\d+(\.\d+)?)$'
LIMIT 10;

-- Show cleanup summary
SELECT 
    COUNT(*) as total_entries,
    COUNT(CASE 
        WHEN value = '[object Object]' 
          OR value = '"[object Object]"' 
        THEN 1 END
    ) as corrupted_entries_remaining
FROM internal_kv;