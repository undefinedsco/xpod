/**
 * PatternBuilder - QuintPattern construction from SPARQL algebra
 * 
 * Builds QuintPattern objects from SPARQL algebra patterns,
 * applying security filters and pushdown conditions.
 */

import type { Term, Variable, Bindings } from '@rdfjs/types';
import type { Algebra } from 'sparqlalgebrajs';

import type { QuintPattern, TermOperators } from '../quint/types';
import type { SecurityFilters } from './ComunicaQuintEngine';

/**
 * Pushdown filters extracted from SPARQL FILTER clauses
 * Maps variable names to their filter conditions
 */
export interface PushdownFilters {
  [varName: string]: TermOperators;
}

/**
 * PatternBuilder constructs QuintPattern objects from SPARQL algebra
 */
export class PatternBuilder {
  constructor(
    private readonly getSecurityFilters: () => SecurityFilters | undefined
  ) {}

  /**
   * Build base QuintPattern from SPARQL pattern (without pushdown filters)
   */
  buildBasePattern(pattern: Algebra.Pattern): QuintPattern {
    const quintPattern: QuintPattern = {};
    
    if (pattern.subject && pattern.subject.termType !== 'Variable') {
      quintPattern.subject = pattern.subject;
    }
    if (pattern.predicate && pattern.predicate.termType !== 'Variable') {
      quintPattern.predicate = pattern.predicate;
    }
    if (pattern.object && pattern.object.termType !== 'Variable') {
      quintPattern.object = pattern.object;
    }
    if (pattern.graph && pattern.graph.termType !== 'Variable' && pattern.graph.termType !== 'DefaultGraph') {
      quintPattern.graph = pattern.graph;
    }

    // Apply security filters
    const securityFilters = this.getSecurityFilters();
    if (securityFilters) {
      if (securityFilters.subject && !quintPattern.subject) {
        quintPattern.subject = securityFilters.subject;
      }
      if (securityFilters.predicate && !quintPattern.predicate) {
        quintPattern.predicate = securityFilters.predicate;
      }
      if (securityFilters.object && !quintPattern.object) {
        quintPattern.object = securityFilters.object;
      }
      if (securityFilters.graph && !quintPattern.graph) {
        quintPattern.graph = securityFilters.graph;
      }
    }

    return quintPattern;
  }

  /**
   * Build QuintPattern with pushdown filters applied
   */
  buildQuintPattern(pattern: Algebra.Pattern, pushdownFilters: PushdownFilters): QuintPattern {
    const quintPattern = this.buildBasePattern(pattern);

    // Apply pushdown filters to appropriate positions
    if (pattern.subject?.termType === 'Variable' && pushdownFilters[pattern.subject.value]) {
      quintPattern.subject = this.mergeFilters(quintPattern.subject, pushdownFilters[pattern.subject.value]);
    }
    if (pattern.predicate?.termType === 'Variable' && pushdownFilters[pattern.predicate.value]) {
      quintPattern.predicate = this.mergeFilters(quintPattern.predicate, pushdownFilters[pattern.predicate.value]);
    }
    if (pattern.object?.termType === 'Variable' && pushdownFilters[pattern.object.value]) {
      quintPattern.object = this.mergeFilters(quintPattern.object, pushdownFilters[pattern.object.value]);
    }
    if (pattern.graph?.termType === 'Variable' && pushdownFilters[pattern.graph.value]) {
      quintPattern.graph = this.mergeFilters(quintPattern.graph, pushdownFilters[pattern.graph.value]);
    }

    return quintPattern;
  }

  /**
   * Build pattern for EXISTS subquery with bound variables
   */
  buildExistsPattern(subPattern: Algebra.Pattern, binding: Bindings): QuintPattern {
    const quintPattern: QuintPattern = {};
    
    const getBound = (term: Term | undefined): Term | undefined => {
      if (!term) return undefined;
      if (term.termType === 'Variable') {
        return binding.get(term as Variable) || undefined;
      }
      return term;
    };

    const subject = getBound(subPattern.subject);
    if (subject && subject.termType !== 'Variable') quintPattern.subject = subject;
    
    const predicate = getBound(subPattern.predicate);
    if (predicate && predicate.termType !== 'Variable') quintPattern.predicate = predicate;
    
    const object = getBound(subPattern.object);
    if (object && object.termType !== 'Variable') quintPattern.object = object;
    
    const graph = getBound(subPattern.graph);
    if (graph && graph.termType !== 'Variable' && graph.termType !== 'DefaultGraph') {
      quintPattern.graph = graph;
    }

    // Apply security filters
    const securityFilters = this.getSecurityFilters();
    if (securityFilters?.graph && !quintPattern.graph) {
      quintPattern.graph = securityFilters.graph;
    }

    return quintPattern;
  }

  /**
   * Merge existing filter with new filter
   * Concrete terms take precedence over operators
   */
  private mergeFilters(existing: Term | TermOperators | undefined, newFilter: TermOperators): Term | TermOperators {
    if (!existing) return newFilter;
    if ('termType' in existing) return existing; // Concrete term takes precedence
    return { ...existing, ...newFilter };
  }
}
