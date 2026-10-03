// Values the integration global setup provides to every test file.
declare module 'vitest' {
  export interface ProvidedContext {
    pmPostgres: {
      adminUrl: string;
      host: string;
      port: number;
      mode: string;
      passwords: Record<string, string>;
      template: string;
    };
  }
}

export {};
