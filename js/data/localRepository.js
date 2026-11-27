import { createRepository, localAdapter } from './repository.js';

/** Repositori per defecte: localStorage del navegador. */
export const repo = createRepository(localAdapter);
