declare module '@deepseek-ai/schemastery' {
  interface SchemaBuilder {
    default(value: unknown): this;
    description(text: string): this;
    required(): this;
  }
  interface Schema extends SchemaBuilder {
    object(fields: Record<string, unknown>): Schema;
    string(): Schema;
    number(): Schema;
    boolean(): Schema;
    array(item: unknown): Schema;
  }
  const Schema: Schema;
  export default Schema;
}
