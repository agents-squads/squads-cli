// Ambient shim for js-yaml (direct dep, ^4.3.0) — ships no bundled TS types and
// we avoid pulling @types/js-yaml. Declares only the surface we use.
declare module 'js-yaml' {
  export function load(input: string, options?: unknown): unknown;
  export function dump(input: unknown, options?: unknown): string;
  const jsYaml: { load: typeof load; dump: typeof dump };
  export default jsYaml;
}
