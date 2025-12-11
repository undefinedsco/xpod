import { getBackend } from '../../../src/libs/backends';
import { AbstractLevel } from 'abstract-level';

describe('getBackend', () => {
  // Use unique in-memory databases for each test block or ensure proper closing
  // For simplicity, using a fixed in-memory DB for now as `getBackend` doesn't expose close
  
  it('should return the same backend instance for the same endpoint and table name', async () => {
    // Using a unique in-memory database name for this test
    const endpoint = 'sqlite::memory:test_same_instance';
    const tableName = 'test_table_1';

    const backend1 = getBackend(endpoint, { tableName });
    const backend2 = getBackend(endpoint, { tableName });

    expect(backend1).toBeInstanceOf(AbstractLevel);
    expect(backend2).toBeInstanceOf(AbstractLevel);
    expect(backend1).toBe(backend2); // Expect strict equality (same instance)
    
    // Ensure all backends are closed after tests to release resources
    // (This is a simplified test, real app would manage lifecycle better)
    await backend1.close();
  });

  it('should return different backend instances for different table names on the same endpoint', async () => {
    const endpoint = 'sqlite::memory:test_different_tables';
    const tableName1 = 'test_table_a';
    const tableName2 = 'test_table_b';

    const backend1 = getBackend(endpoint, { tableName: tableName1 });
    const backend2 = getBackend(endpoint, { tableName: tableName2 });

    expect(backend1).not.toBe(backend2); // Expect different instances
    
    await backend1.close();
    await backend2.close();
  });

  it('should return different backend instances for different endpoints', async () => {
    const endpoint1 = 'sqlite::memory:test_different_endpoints1';
    const endpoint2 = 'sqlite::memory:test_different_endpoints2';
    const tableName = 'test_table_3';

    const backend1 = getBackend(endpoint1, { tableName });
    const backend2 = getBackend(endpoint2, { tableName });

    expect(backend1).not.toBe(backend2); // Expect different instances
    
    await backend1.close();
    await backend2.close();
  });

  it('should handle different protocols correctly', async () => {
    const fileEndpoint = 'file:./test_level_db_for_test'; // ClassicLevel still needs a file
    const sqlEndpoint = 'sqlite::memory:test_sql_in_memory';
    const tableName = 'generic_table';

    const fileBackend = getBackend(fileEndpoint, { tableName });
    const sqlBackend = getBackend(sqlEndpoint, { tableName });

    expect(fileBackend).toBeInstanceOf(AbstractLevel);
    expect(sqlBackend).toBeInstanceOf(AbstractLevel);
    expect(fileBackend).not.toBe(sqlBackend);
    
    await fileBackend.close();
    await sqlBackend.close();
  });
});
