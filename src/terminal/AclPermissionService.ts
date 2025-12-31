/**
 * ACL Permission Service for Terminal Sidecar
 *
 * Queries Quadstore to check if a user has acl:Control permission
 * on a resource, which is required for Terminal access.
 */
import { getLoggerFor } from 'global-logger-factory';
import { SubgraphQueryEngine, QuadstoreSparqlEngine } from '../storage/sparql/SubgraphQueryEngine';

export class AclPermissionService {
  protected readonly logger = getLoggerFor(this);
  private engine?: SubgraphQueryEngine;
  private readonly sparqlEndpoint?: string;

  public constructor(sparqlEndpoint?: string) {
    this.sparqlEndpoint = sparqlEndpoint;
  }

  private getEngine(): SubgraphQueryEngine {
    if (!this.engine) {
      if (!this.sparqlEndpoint) {
        throw new Error('SPARQL endpoint not configured');
      }
      this.engine = new SubgraphQueryEngine(new QuadstoreSparqlEngine(this.sparqlEndpoint));
    }
    return this.engine;
  }

  /**
   * Check if a user has acl:Control permission on a resource.
   *
   * Checks for:
   * - Direct agent match: acl:agent <userId>
   * - Public access: acl:agentClass foaf:Agent
   * - Authenticated access: acl:agentClass acl:AuthenticatedAgent
   *
   * @param userId - The WebID of the user
   * @param resourceUrl - The URL of the resource to check
   * @returns true if user has Control permission
   */
  public async hasControlPermission(userId: string, resourceUrl: string): Promise<boolean> {
    const engine = this.getEngine();

    // Normalize resource URL (remove trailing slash for consistency)
    const normalizedResource = resourceUrl.endsWith('/')
      ? resourceUrl.slice(0, -1)
      : resourceUrl;

    // Also check the container version (with trailing slash)
    const containerResource = normalizedResource + '/';

    const query = `
      PREFIX acl: <http://www.w3.org/ns/auth/acl#>
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>

      ASK {
        ?auth a acl:Authorization ;
              acl:mode acl:Control .

        # Match either the exact resource or container
        {
          ?auth acl:accessTo <${normalizedResource}> .
        } UNION {
          ?auth acl:accessTo <${containerResource}> .
        } UNION {
          ?auth acl:default <${normalizedResource}> .
        } UNION {
          ?auth acl:default <${containerResource}> .
        }

        # Match user by agent, agentClass, or agentGroup
        {
          ?auth acl:agent <${userId}> .
        } UNION {
          ?auth acl:agentClass foaf:Agent .
        } UNION {
          ?auth acl:agentClass acl:AuthenticatedAgent .
        }
      }
    `;

    try {
      const hasPermission = await engine.queryBoolean(query, resourceUrl);
      this.logger.debug(`ACL check: user=${userId}, resource=${resourceUrl}, hasControl=${hasPermission}`);
      return hasPermission;
    } catch (error) {
      this.logger.error(`ACL query failed: ${error}`);
      return false;
    }
  }

  /**
   * Get all resources where user has Control permission under a base path.
   *
   * @param userId - The WebID of the user
   * @param basePath - The base path to search under
   * @returns Array of resource URLs with Control permission
   */
  public async getControlledResources(userId: string, basePath: string): Promise<string[]> {
    const engine = this.getEngine();

    const query = `
      PREFIX acl: <http://www.w3.org/ns/auth/acl#>
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>

      SELECT DISTINCT ?resource WHERE {
        ?auth a acl:Authorization ;
              acl:mode acl:Control .

        # Get the resource
        {
          ?auth acl:accessTo ?resource .
        } UNION {
          ?auth acl:default ?resource .
        }

        # Filter by base path
        FILTER(STRSTARTS(STR(?resource), "${basePath}"))

        # Match user
        {
          ?auth acl:agent <${userId}> .
        } UNION {
          ?auth acl:agentClass foaf:Agent .
        } UNION {
          ?auth acl:agentClass acl:AuthenticatedAgent .
        }
      }
    `;

    try {
      const resources: string[] = [];
      const stream = await engine.queryBindings(query, basePath);

      for await (const binding of stream) {
        const value = binding.get('resource');
        if (value && typeof value === 'object' && 'value' in value) {
          resources.push((value as { value: string }).value);
        }
      }

      this.logger.debug(`Found ${resources.length} controlled resources for user=${userId} under ${basePath}`);
      return resources;
    } catch (error) {
      this.logger.error(`ACL query failed: ${error}`);
      return [];
    }
  }
}
