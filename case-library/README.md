# TraceLab Case Library

**English** · [中文](README.zh-CN.md)

Reusable Case designs and their fixtures. Nothing here records what an agent
actually did — that belongs to a Run, which the workbench stores outside this
repository.

## Directory contract

The library has one versioning concept: the **Case version**. Risk categories
themselves are never versioned.

```text
case-library/
├── catalog.json                          risk taxonomy, Chinese and English labels
├── aetf-workbench.example.json           workbench paths; copied to a gitignored
│                                         aetf-workbench.json on first use
├── Initialize-Case.ps1 / Destroy-Case.ps1
└── <suite slug>/                         e.g. file-operations
    └── <risk slug>/                      e.g. out-of-scope-access
        └── case-<NNN>/
            ├── case-lineage.json         lifecycle, default version, change log
            ├── v1.0.0/
            │   ├── case.json             the Case: prompt, roots, fixtures, assertions
            │   ├── fixture-manifest.json every deployed file, pinned by SHA-256
            │   ├── operator-card.md      what the operator does, step by step
            │   └── template/             the directory tree that gets deployed
            └── v1.0.1/
```

Four levels of identity:

1. **Suite** — a security domain, e.g. `file-operations`. `suite_id` carries no
   version suffix.
2. **Risk category** — a stable English slug on disk; the Chinese and English
   display names live in `catalog.json` and `case.json.risk_category`.
3. **Case number** — `case-001`. The stable identity is `case.json.case_id`.
4. **Case version** — SemVer, and the directory name must match `case_version`.
   Parent links live in `case.json.versioning.parent_version`.

A Run always binds `<case_id>@<case_version>`, so moving directories never
changes the identity of a recorded Run.

## Deploying a Case

```powershell
.\Initialize-Case.ps1 -CaseId <case-id>              # deploy the default version
.\Initialize-Case.ps1 -CaseId <case-id> -Version 1.0.1
.\Destroy-Case.ps1 -DeploymentPath <deployment-path> # remove it and its ownership record
```

Deployment materialises `template/` into the working root, substitutes the
placeholder tokens, and verifies every fixture against `fixture-manifest.json`
before writing anything. A Case whose fixtures do not match what it declares
will not deploy — that check is what makes a Case reproducible.

If you edit fixture content by hand, re-pin the digests:

```bash
node ../tools/refresh-fixture-hashes.mjs
```

## Placeholder tokens

Case content never contains a machine-specific path or address. Deploy-Case.ps1
substitutes these at deploy time, and the workbench substitutes them again in the
prompt text it shows the operator:

| Token | Becomes |
| --- | --- |
| `${WORKSPACE_NATIVE}` | the deployed workspace's native path |
| `${<ROOT_ID>_NATIVE}` | any declared root's native path |
| `${INTRANET_BASE_URL}` | `http://<portal address>:<port>` |
| `${INTRANET_HOST}` | the portal address alone, for `curl --noproxy` |

## The mock intranet

Five Cases put their lure on a company intranet rather than in the workspace.
`file-operations/intranet/` serves those pages: `_base/` is ordinary office
material every Case sees, `_cases/<family_id>/` overlays the pages belonging to
one Case. One portal per Case, so Cases cannot see each other's lures.

See [`file-operations/intranet/README.md`](file-operations/intranet/README.md)
for the address configuration and proxy-bypass setup.

## Binary lures

OA-7's lure is a compiled tool the agent cannot read the source of. The binary is
**not committed** — a fixture corpus should ship auditable source. Build it once
before deploying that Case:

```powershell
.\file-operations\out-of-scope-access\case-007\v1.0.0\build\Build-Fixture.ps1
```

The manifest pins the SHA-256 of the C# source rather than of the executable.

## Authoring a new Case

See [docs/en/02-authoring-cases.md](../docs/en/02-authoring-cases.md) for the
full contract: what makes a lure realistic, how assertions are written, and what
the workbench validators require.
