# Extending the Codemod Catalog

The AST codemod catalog supports runtime-registered custom codemods alongside the built-in ones.

## Registering a Custom Codemod

```typescript
import { registerCustomCodemod } from "./domains/patch-exec/astCodemodCatalog";

registerCustomCodemod({
  id: "my_custom_transform",
  label: "My Custom Transform",
  description: "Transforms X into Y with safety checks",
  requiredArgs: ["targetFile", "targetSymbols"],
  citationToken: "codemod:my_custom_transform",
});
```

## Via Memory / Seed Data

Custom codemods can be registered through the memory system. When a memory record
with enforcement type `strategy_signal` includes a codemod registration, the
controller registers it on startup.

## API

| Function | Purpose |
|----------|---------|
| `registerCustomCodemod(descriptor)` | Add a custom codemod to the runtime registry |
| `clearCustomCodemods()` | Remove all custom codemods |
| `listCustomCodemods()` | List registered custom codemod IDs |
| `isSupportedAstCodemodId(id)` | Check built-in + custom registry |
| `resolveCodemodDescriptor(id)` | Get descriptor from either source |

## Listing All Codemods

`listAstCodemods()` returns both built-in and custom codemods. The `listPatchApplyOptions()`
response includes `customCodemodsAllowed: true` to signal agents that extension is possible.
