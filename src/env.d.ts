/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by middleware for every authenticated route. */
    user?: import('./lib/auth').Session;
    /** Set when the request runs inside a share (lib/shares.ts): the owner is `user`, this says what the visitor may do. */
    share?: import('./lib/shares').ShareLocals;
  }
}
