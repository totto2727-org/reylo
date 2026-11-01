# HCL native parser conformance tests

These tests use the official [HashiCorp HCL v2.25.0 source](https://github.com/hashicorp/hcl/tree/00057cf06d7b38a3f89e6e54d622eee98322b314), pinned at `00057cf06d7b38a3f89e6e54d622eee98322b314`.
The upstream source and its derived fixtures are MPL-2.0.
The license is retained in [LICENSE](./LICENSE).

## Run

From the Reylo repository root:

```sh
node --test tests/hclsyntax/*.test.ts
```

The normal repository `node --test 'tests/**/*.test.ts'` command also discovers this suite.
Running these tests needs only Node and the local TypeScript parser sources.
It does not run Go, Atlas, a package manager, or a subprocess.

## Coverage

[manifest.json](./manifest.json) records each upstream test function, its captured calls, case counts, APIs, and exclusions.
The 728 official oracle fixtures comprise 688 calls from the original test functions and 40 raw official corpus inputs.
Three complete `TestPeeker` scenarios and a fixture-manifest consistency check bring the HCL portion to 732 tests.
No cases are skipped.

The full original tables are retained for:

- `TestParseConfig`: 48 cases.
- `TestParseConfig_incompleteFunctionCall`: 11 cases.
- `TestParseConfigDiagnostics`: 15 cases.
- `TestScanTokens_normal`: 62 cases.
- `TestScanTokens_template`: five cases.
- `TestScanStringLit`: all 32 inputs, each in quoted and unquoted mode, for 64 cases.
- `TestCheckInvalidTokensTest`: six cases.
- `TestValidIdentifier`: 24 cases, including malformed UTF-8 bytes.
- `TestPeeker`: all three comment/newline-stack scenarios, with every `Peek`/`Read` equality and expected token sequence.

All parsing calls from the mixed expression/template tests are retained, including dynamically generated Boolean-expression inputs.
These tests compare parsing results, not HCL expression evaluation.
The static-template helper is checked against the complete nine-case `TestTemplateExprIsStringLiteral` table.
The two graceful-value tests contribute their malformed parsing inputs without claiming their excluded `Expression.Value` assertions are ported.

The corpus contributes all 15 native `.hcl` files from `specsuite/tests`, seven configuration fuzz seeds, ten expression fuzz seeds, and eight template fuzz seeds.
The four standalone traversal-parser seeds are excluded because that API is not ported.
The `.hcldec` decoding schemas and `.t` evaluation expectations do not become parser-evaluation claims.

## Oracle and comparison boundaries

[fixtures.jsonl](./fixtures.jsonl) stores original input bytes in base64, the original test case name, filename/start position, and the pinned Go implementation's result.
It contains complete token bytes/types/ranges, parser diagnostics, and parser-reachable exported AST fields with computed ranges.
The expected data is never generated from the TypeScript implementation.

[oracle-shape.ts](./oracle-shape.ts) adapts names and data carriers between Go and TypeScript.
It normalizes Go nil and empty slices into JavaScript arrays, maps the narrow parser-side cty literals into the port's literal/dynamic carriers, and excludes private evaluator state.
The comparison retains every represented AST field and source range, including ASTs returned during error recovery.
Diagnostics compare severity, summary, detail, subject, and context.
The parser never supplies evaluation context or expression-evaluation metadata to these comparisons.

TypeScript-only convenience fields `traversal.parts` and `splat.attributeOnly` have no separate field in the pinned Go AST and are not asserted as independent Go fields.
The canonical comparison uses numeric `value` as the host JavaScript number representation, while a separate assertion requires each numeric literal's `numberText` to match the exact original byte slice.
This preserves the source spelling of long fractions and large numeric literals instead of claiming JavaScript floating-point values have cty's precision.

Evaluation, JSON syntax, standalone traversal parsing, generic body decoding, navigation, variable enumeration, and walking are outside the selected parser scope.
`pos_test.go` tests `RangeOver`, position overlap, and range partitioning, none of which the port copies.
The lexical performance benchmark is not a correctness test and is not included in the test count.

## Character positions

Character segmentation uses the runtime's standard `Intl.Segmenter`, with UTF-16 boundaries mapped back to the original UTF-8 source bytes.
The scanner has no copied textseg Unicode tables or independent textseg conformance suite.
Unicode-version differences in grapheme columns are accepted when they do not change HCL parsing; this suite checks HCL tokens, ASTs, diagnostics and source positions instead of reproducing a dependency's internals.

## Reproduce the fixtures

The development-only exporter needs a checkout of the exact pinned upstream revision and a Go toolchain compatible with upstream.
It may download upstream's Go build dependencies.
The maintained TypeScript test run never does this.

```sh
GO="$HOME/.nix-profile/bin/go" node tests/hclsyntax/tooling/export.mjs /absolute/path/to/pinned/hcl
```

The default checkout path is `tmp/direct-hcl/upstream`.
The exporter refuses another Git revision.

[tooling/instrument.go](./tooling/instrument.go) parses the original Go test files with Go's AST parser and replaces only calls to selected parsing/scanning APIs with pass-through recording wrappers.
The wrappers are inserted through `go test -overlay`, not by editing upstream implementation source.
All original test tables and assertions execute against the original implementation, including the evaluator assertions in mixed tests.
The exporter writes fixtures only after the full original `hclsyntax` package test suite passes.
The original Go assertions therefore validate the implementation used as the oracle, while only in-scope parser/scanner results are recorded for TypeScript.
The synthetic corpus driver reads only official seed/spec input files.

Generated overlay files and intermediate exports stay under `tmp/direct-hcl/` and are not maintained artifacts.
The maintained files are the exporters, recording hooks, deterministic HCL fixture data, the explicit coverage manifest, test harnesses, this document, and the upstream license.
The HCL exporter was run twice with byte-identical fixture output to verify reproducibility.

## Source references

- [Native parser tests](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/hclsyntax/parser_test.go).
- [Token scanner tests](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/hclsyntax/scan_tokens_test.go).
- [String scanner tests](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/hclsyntax/scan_string_lit_test.go).
- [Peeker tests](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/hclsyntax/peeker_test.go).
- [Mixed expression tests](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/hclsyntax/expression_test.go).
- [Mixed template tests](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/hclsyntax/expression_template_test.go).
- [Specification-suite scope](https://github.com/hashicorp/hcl/blob/00057cf06d7b38a3f89e6e54d622eee98322b314/specsuite/README.md).
