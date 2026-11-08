// Types for deploy-needed.mjs, so the Round 14 tests typecheck.
export declare const DEFAULT_SITE: string;
export declare function isShipped(file: string): boolean;
export declare function deployNeeded(files: string[]): { needed: boolean; shipped: string[]; total: number };
export declare function liveRevision(body: unknown): string | null;
export declare function decide(input: {
  candidate: string;
  fetchHealth: () => Promise<unknown>;
  changedFiles: (from: string, to: string) => string[];
}): Promise<{ needed: boolean; live?: string; reason: string }>;
