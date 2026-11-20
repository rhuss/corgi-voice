// Bun has JSON.rawJSON (TC39 JSON.parse source text access); TypeScript's lib does not declare it yet.
interface JSON {
  rawJSON(text: string): unknown;
}
