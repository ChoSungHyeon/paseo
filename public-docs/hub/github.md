---
title: GitHub access
description: Grant one workflow step a scoped GitHub token and git setup.
nav: GitHub access
order: 65
category: Hub
---

# GitHub access

A trigger grants no GitHub credential. Put a `github` block on the step that needs repository authority:

```yaml
name: implement-request
on: github.issue_comment
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
steps:
  - id: implement
    environment: development
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        contents: write
        pull_requests: write
    prompt:
      - text: |
          Implement the request, push a branch, and open a pull request with gh.
          Call hub.finish_execution when done.
          ${{ paseo.prompt }}
```

The agent can use `git` and `gh` within the declared repositories and permissions. Hub mints the token when the step starts and revokes it when execution ends or its configured duration elapses.

## Fields

| Field          | Notes                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`   | Project GitHub connection slug.                                                                                                        |
| `repositories` | Repositories the token can reach. On a GitHub-triggered run, this defaults to the triggering repository. Required for other providers. |
| `permissions`  | Installation-token permissions such as `contents`, `pull_requests`, and `issues`. Defaults to `contents: read`.                        |
| `duration`     | Positive token lifetime up to `1h`. Defaults to `1h`, GitHub's maximum.                                                                |

Requested authority cannot exceed the GitHub App installation. Activation and dispatch fail clearly when the connection, repository, or permissions cannot be resolved.

## Restarts and credential lifetime

Restarting Hub preserves active executions and their existing credentials. Hub reconnects to the same agent and restores the original credential deadlines. A restart does not mint a replacement token or extend its lifetime.

If Hub is unavailable when a shorter duration elapses, it revokes the overdue token when it returns. GitHub’s own expiry still limits the token lifetime to one hour. Revocation failures are retried after recovery.

## Agent environment

Hub supplies `GH_TOKEN` and process-scoped git configuration through environment variables:

- Commits use the App bot login as `user.name` and `<app-id>+<bot-login>@users.noreply.github.com` as `user.email`.
- `git@github.com:` and `ssh://git@github.com/` remotes are rewritten to HTTPS.
- `gh auth git-credential` handles GitHub credentials for the step.
- User-global and system git configuration are ignored, and terminal credential prompts are disabled.
- The daemon host's git identity and credentials are not read or changed.

`GH_TOKEN` and Hub's git configuration variables are reserved when a step has a `github` block; workflow `env` cannot replace them.

## Keep authority on the worker

A classifier can read untrusted request text without GitHub authority. Put the `github` block only on the later branch that makes a change. [Workflow routing](/docs/hub/workflows#route-from-a-classifier) shows the ordered classifier/worker shape.

Connection values for other integrations remain explicit step environment values:

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

Hub persists resolved values as private execution data so it can recover after a restart. Authored configuration retains the expressions.

These values are stored in the Hub database without application-level encryption. Protect database access, storage, and backups as credentials. Hub deletes the execution authority record when the execution becomes terminal; token lease records remain until revocation succeeds or the token expires, so interrupted cleanup can resume. This cleanup is not a guarantee that every copy is erased: retained agent/session data and database backups may still contain resolved values. Token revocation ends access; it does not erase those copies. Backup retention and deletion remain the operator’s responsibility.

See [Hub security](/docs/hub/security) for provider and host boundaries.
