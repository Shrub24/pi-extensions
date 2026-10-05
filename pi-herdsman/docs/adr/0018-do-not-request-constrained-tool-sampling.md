# Do not request constrained tool sampling

Status: accepted

Herdsman declares its tools with a JSON schema and validates every argument itself. It does not ask for grammar-constrained generation: no tool carries `constrainedSampling`.

When a model's provider supports strict tools, Pi turns each marked tool into a strict JSON schema, and Anthropic compiles one grammar per request over every strict tool in the session. That budget is global and invisible — a package cannot see the strict tools of the other packages or of Pi itself — so a package that claims the constraint without needing it can push a session past the ceiling. The failure is a 400 on every request: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."

Nothing is lost by omitting it. `strict` constrains sampling, not validation: the schemas are still checked, the delegation brief is still parsed and rejected with typed errors, and a malformed call still returns an error to the model. The tools that gained least were the argument-free ones — listing, stopping, completing, discarding — where a grammar is compiled over an empty schema.

Tests in `extension-contract.test.ts` and `extension-cutover.test.ts` assert that no registered tool declares it, so the decision is not re-litigated by accident.
