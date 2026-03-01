/**
 * Runtime guard for named scope collisions.
 *
 * Enforces that two active child scopes under the same parent scope path
 * cannot share the same name.
 */
export class ScopeNameCollisionError extends Error {
  constructor(scopeName: string, parentPath: readonly string[]) {
    super(
      `Scope name collision: "${scopeName}" is already active under parent path "${parentPath.join("/")}"`,
    );
    this.name = "ScopeNameCollisionError";
  }
}

export class ScopeRuntimeRegistry {
  private readonly activeChildrenByParent = new Map<string, Set<string>>();

  enterChildScope(
    parentPath: readonly string[],
    scopeName: string,
  ): readonly string[] {
    const parentKey = this.parentKey(parentPath);
    const activeChildren = this.activeChildrenByParent.get(parentKey) ?? new Set();
    if (activeChildren.has(scopeName)) {
      throw new ScopeNameCollisionError(scopeName, parentPath);
    }
    activeChildren.add(scopeName);
    this.activeChildrenByParent.set(parentKey, activeChildren);
    return [...parentPath, scopeName];
  }

  leaveChildScope(parentPath: readonly string[], scopeName: string): void {
    const parentKey = this.parentKey(parentPath);
    const activeChildren = this.activeChildrenByParent.get(parentKey);
    if (!activeChildren) return;

    activeChildren.delete(scopeName);
    if (activeChildren.size === 0) {
      this.activeChildrenByParent.delete(parentKey);
    }
  }

  private parentKey(parentPath: readonly string[]): string {
    return parentPath.join("\u0000");
  }
}
