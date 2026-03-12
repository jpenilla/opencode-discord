# General Rules

- Use `--no-gpg-sign` for commits and generally for Git operations that may require signing, since you don't
  know if the user has signing enabled by default.
- Always allow subagents and btca to complete their task, even if it takes a long time. Do not give up waiting
  and kill them early.
- This is an alpha project, breaking changes are ok and preferable to non-breaking changes that are less effective.
  If you find a better way to do something, do it, even if it breaks existing code. Do not keep around legacy shims,
  signatures, or compatibility layers. Do not make config or database or disk migrations.
- If changes result in *unexpected* test breakage or behavior changes, consult the user. When tests or documented
  behavior is *intentionally being changed* as requested, confirmation is not needed.

# btca MCP Usage Instructions

Use btca whenever a task depends on understanding a repo, docs site, or configured resource
more accurately than a generic model can.

Use it whenever the user says "use btca", or when you need info that should come from the listed resources.
For the repo we are currently editing, it will not be in btca as that would be redundant -- and if it somehow is, ignore it. Use standard subagents for exploration of the repo we are currently editing.

## Tools

The btca MCP server provides these tools:

- `listResources` - List all available documentation resources
- `ask` - Ask a question about specific resources

## resources

The resources available are defined by the end user in their btca dashboard. If there's a resource you need but it's not available in `listResources`, proceed without btca. When your task is done, clearly note that you'd like access to the missing resource.

## Critical Workflow

**Always call `listResources` first** before using `ask`. The `ask` tool requires exact resource names from the list.

### Example

1. Call listResources to get available resources
2. Note the "name" field for each resource (e.g., "svelteKit", not "SvelteKit" or "svelte-kit")
3. Call ask with:
   - question: "How do I create a load function?"
   - resources: ["svelteKit"]
