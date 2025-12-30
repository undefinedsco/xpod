/**
 * Test to verify that getSelectorShape correctly declares FILTER support
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataFactory } from 'n3';
import { DataFactory as RdfDataFactory } from 'rdf-data-factory';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import { QuintQuerySource } from '../../../src/storage/sparql/QuintQuerySource';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { doesShapeAcceptOperation } from '@comunica/utils-query-operation';
import { Algebra, translate } from 'sparqlalgebrajs';

const { namedNode, literal, quad } = DataFactory;
const dataFactory = new RdfDataFactory();

describe('QuintQuerySource shape and FILTER pushdown', () => {
  let store: SqliteQuintStore;
  let querySource: QuintQuerySource;
  let bindingsFactory: any;

  beforeEach(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    bindingsFactory = new (BindingsFactory as any)(dataFactory);
    
    querySource = new QuintQuerySource(store as any, {
      debug: true,
      bindingsFactory,
      getSecurityFilters: () => undefined,
      getOptimizeParams: () => null,
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it('should declare support for FILTER operations', async () => {
    const shape = await querySource.getSelectorShape({} as any);
    console.log('Shape:', JSON.stringify(shape, null, 2));
    
    // Should be a disjunction
    expect(shape.type).toBe('disjunction');
    
    // Should have children
    expect((shape as any).children).toBeDefined();
    expect((shape as any).children.length).toBeGreaterThan(1);
    
    // One child should support FILTER type
    const filterChild = (shape as any).children.find((child: any) => 
      child.type === 'operation' && 
      child.operation?.operationType === 'type' && 
      child.operation?.type === Algebra.types.FILTER
    );
    
    expect(filterChild).toBeDefined();
    console.log('FILTER support declared:', filterChild);
  });

  it('should have shape that accepts FILTER operation', async () => {
    const shape = await querySource.getSelectorShape({} as any);
    
    // Parse a FILTER query to get the algebra
    const query = `
      SELECT ?s ?value WHERE {
        ?s <http://example.org/value> ?value .
        FILTER(?value > 15)
      }
    `;
    const algebra = translate(query);
    
    // Find the FILTER operation
    let filterOp: Algebra.Operation | null = null;
    const findFilter = (op: Algebra.Operation): void => {
      if (op.type === Algebra.types.FILTER) {
        filterOp = op;
        return;
      }
      if ('input' in op && op.input) {
        if (Array.isArray(op.input)) {
          op.input.forEach(findFilter);
        } else {
          findFilter(op.input as Algebra.Operation);
        }
      }
    };
    findFilter(algebra);
    
    expect(filterOp).not.toBeNull();
    
    // Test if shape accepts the FILTER operation
    const accepted = doesShapeAcceptOperation(shape as any, filterOp!);
    console.log('Shape accepts FILTER operation:', accepted);
    expect(accepted).toBe(true);
  });
});
