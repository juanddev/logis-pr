declare const __VERSION__: string | undefined;

/** Diisi saat build (tsup `define`); fallback untuk `npm run dev`. */
export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';
