// RFC 8785 canonical JSON lives in @pm/contracts (browser-safe) so the web client hashes rich-text
// base values exactly as the server does; the platform keeps its existing export.
export { canonicalJson } from '@pm/contracts';
