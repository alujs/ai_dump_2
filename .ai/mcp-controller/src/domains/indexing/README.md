# Indexing Domain

## Purpose

Provides AST tooling for TS/JS and Angular template analysis.

## How to extend

- Add parser adapters per file type while preserving normalized outputs.
- Keep parser errors structured and observable.

## Gotchas

- Do not silently skip parser failures.
- Keep Angular template parsing contract-compatible with host Angular version.

## Invariants

- TS/JS analysis is powered by `ts-morph`.
- Angular template analysis uses `@angular/compiler`.
