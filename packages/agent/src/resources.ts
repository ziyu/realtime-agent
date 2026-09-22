import { AgentError } from './common.js';

export interface ResourceLease { readonly owner: string; readonly resources: readonly string[] }

/** Share one arbiter between every Agent controlling the same device. Acquisition is all-or-nothing. */
export class ResourceArbiter {
  private owners = new Map<string, ResourceLease>();

  private names(resources: readonly string[]): string[] {
    if (!Array.isArray(resources) || resources.length > 32 || resources.some(r => typeof r !== 'string' || !r.trim() || r.length > 240)) {
      throw new AgentError('invalid_resources', 'Expected at most 32 named resources.');
    }
    return [...new Set(resources)].sort();
  }

  available(resources: readonly string[], replacing?: ResourceLease): boolean {
    return this.names(resources).every(name => !this.owners.has(name) || this.owners.get(name) === replacing);
  }

  acquire(owner: string, resources: readonly string[]): ResourceLease {
    const names = this.names(resources);
    if (!owner || !this.available(names)) throw new AgentError('resource_busy', 'A required device resource is still in use.', 0);
    const lease = Object.freeze({ owner, resources: Object.freeze(names) });
    for (const name of names) this.owners.set(name, lease);
    return lease;
  }

  release(lease: ResourceLease): void {
    // Object identity prevents another instance with a coincidentally equal execution ID releasing a lease.
    for (const name of lease.resources) if (this.owners.get(name) === lease) this.owners.delete(name);
  }

  snapshot(): { resource: string; owner: string }[] {
    return [...this.owners].map(([resource, lease]) => ({ resource, owner: lease.owner }));
  }
}
