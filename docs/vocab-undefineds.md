# Undefineds Vocabulary

**Namespace URI:** `https://undefineds.co/ns/`  
**Preferred Prefix:** `udf`

This vocabulary defines terms for credential management and external service mounting in Solid Pods.

## Overview

```turtle
@prefix udf: <https://undefineds.co/ns/> .
@prefix doap: <http://usefulinc.com/ns/doap#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
```

---

## Classes

### udf:Credential

A stored credential for accessing external services.

| Property | Range | Description |
|----------|-------|-------------|
| `udf:service` | `xsd:anyURI` | The service this credential is for |
| `udf:username` | `xsd:string` | Username or account identifier |
| `udf:token` | `xsd:string` | API token, password, or secret |
| `udf:expiresAt` | `xsd:dateTime` | Optional expiration timestamp |

**Subclasses:**
- `udf:GitHubToken` - GitHub Personal Access Token
- `udf:GitLabToken` - GitLab Access Token
- `udf:OpenAIKey` - OpenAI API Key
- `udf:AWSCredential` - AWS Access Key + Secret

### udf:GitHubToken

A GitHub Personal Access Token.

```turtle
udf:GitHubToken rdfs:subClassOf udf:Credential ;
    rdfs:label "GitHub Token" ;
    rdfs:comment "Personal Access Token for GitHub API" .
```

### udf:GitLabToken

A GitLab Access Token.

### udf:OpenAIKey

An OpenAI API Key.

### udf:AWSCredential

AWS credentials with additional properties:

| Property | Range | Description |
|----------|-------|-------------|
| `udf:accessKeyId` | `xsd:string` | AWS Access Key ID |
| `udf:secretAccessKey` | `xsd:string` | AWS Secret Access Key |
| `udf:region` | `xsd:string` | Default AWS region |

### udf:PasswordCredential

Username/password based credential.

| Property | Range | Description |
|----------|-------|-------------|
| `udf:username` | `xsd:string` | Username |
| `udf:password` | `xsd:string` | Password |

### udf:OAuthCredential

OAuth 2.0 credential.

| Property | Range | Description |
|----------|-------|-------------|
| `udf:clientId` | `xsd:string` | OAuth Client ID |
| `udf:clientSecret` | `xsd:string` | OAuth Client Secret |
| `udf:refreshToken` | `xsd:string` | OAuth Refresh Token |

### udf:SecretStore

A container that organizes and indexes credentials. Used by AI agents to understand the secret storage structure.

| Property | Range | Description |
|----------|-------|-------------|
| `udf:services` | `udf:ServiceConfig[]` | List of configured services |
| `udf:purposes` | `xsd:string[]` | Allowed purpose labels |
| `udf:credentials` | `udf:CredentialRef[]` | Index of stored credentials |

### udf:ServiceConfig

Configuration for a service in the secret store.

| Property | Range | Description |
|----------|-------|-------------|
| `udf:service` | `xsd:anyURI` | Service URI |
| `udf:label` | `xsd:string` | Human-readable name |
| `udf:path` | `xsd:string` | Subdirectory path |
| `udf:supportedTypes` | `xsd:string[]` | Allowed credential types |
| `udf:namingHint` | `xsd:string` | File naming pattern |

---

## Properties

### udf:credentials

Links a resource (e.g., mounted repository) to its credential.

| Domain | Range |
|--------|-------|
| `rdfs:Resource` | `udf:Credential` |

```turtle
udf:credentials a rdf:Property ;
    rdfs:label "credentials" ;
    rdfs:comment "Links to a Credential resource for authentication" ;
    rdfs:range udf:Credential .
```

### udf:service

The external service URI this credential authenticates to.

| Domain | Range |
|--------|-------|
| `udf:Credential` | `xsd:anyURI` |

### udf:username

Username or account identifier.

| Domain | Range |
|--------|-------|
| `udf:Credential` | `xsd:string` |

### udf:token

The secret token value.

| Domain | Range |
|--------|-------|
| `udf:Credential` | `xsd:string` |

### udf:expiresAt

Optional expiration timestamp.

| Domain | Range |
|--------|-------|
| `udf:Credential` | `xsd:dateTime` |

### udf:accessKeyId

AWS Access Key ID.

| Domain | Range |
|--------|-------|
| `udf:AWSCredential` | `xsd:string` |

### udf:secretAccessKey

AWS Secret Access Key.

| Domain | Range |
|--------|-------|
| `udf:AWSCredential` | `xsd:string` |

### udf:region

Default region for cloud services.

| Domain | Range |
|--------|-------|
| `udf:Credential` | `xsd:string` |

### udf:password

Password for username/password authentication.

| Domain | Range |
|--------|-------|
| `udf:PasswordCredential` | `xsd:string` |

### udf:clientId

OAuth Client ID.

| Domain | Range |
|--------|-------|
| `udf:OAuthCredential` | `xsd:string` |

### udf:clientSecret

OAuth Client Secret.

| Domain | Range |
|--------|-------|
| `udf:OAuthCredential` | `xsd:string` |

### udf:refreshToken

OAuth Refresh Token.

| Domain | Range |
|--------|-------|
| `udf:OAuthCredential` | `xsd:string` |

### udf:label

Human-readable label for a resource.

| Domain | Range |
|--------|-------|
| `rdfs:Resource` | `xsd:string` |

### udf:purpose

Usage purpose (e.g., personal, work, prod, dev).

| Domain | Range |
|--------|-------|
| `udf:Credential` | `xsd:string` |

### udf:path

Subdirectory path within secret store.

| Domain | Range |
|--------|-------|
| `udf:ServiceConfig` | `xsd:string` |

### udf:supportedTypes

List of supported credential types for a service.

| Domain | Range |
|--------|-------|
| `udf:ServiceConfig` | `xsd:string[]` |

### udf:namingHint

File naming pattern hint (e.g., `{purpose}.json`).

| Domain | Range |
|--------|-------|
| `udf:ServiceConfig` | `xsd:string` |

---

## Usage Examples

### GitHub Repository Mount

A Pod container representing a mounted GitHub repository:

```turtle
@prefix ldp: <http://www.w3.org/ns/ldp#> .
@prefix doap: <http://usefulinc.com/ns/doap#> .
@prefix udf: <https://undefineds.co/ns/> .

</alice/github/xpod/> a ldp:Container, doap:GitRepository ;
    doap:name "xpod" ;
    doap:location "https://github.com/ganlu/xpod.git" ;
    udf:credentials </alice/.secrets/github.json> .
```

### GitHub Token

```turtle
@prefix udf: <https://undefineds.co/ns/> .

</alice/.secrets/github.json> a udf:Credential, udf:GitHubToken ;
    udf:service <https://github.com> ;
    udf:username "ganlu" ;
    udf:token "ghp_xxxxxxxxxxxxxxxxxxxx" .
```

### OpenAI API Key

```turtle
@prefix udf: <https://undefineds.co/ns/> .

</alice/.secrets/openai.json> a udf:Credential, udf:OpenAIKey ;
    udf:service <https://api.openai.com> ;
    udf:token "sk-xxxxxxxxxxxxxxxxxxxx" .
```

### AWS Credentials

```turtle
@prefix udf: <https://undefineds.co/ns/> .

</alice/.secrets/aws.json> a udf:Credential, udf:AWSCredential ;
    udf:service <https://aws.amazon.com> ;
    udf:accessKeyId "AKIAIOSFODNN7EXAMPLE" ;
    udf:secretAccessKey "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" ;
    udf:region "us-east-1" .
```

---

## Secret Store Structure

AI agents need to understand how to manage credentials in a Pod. The `/.secrets/index.jsonld` file provides a discoverable index.

### Directory Layout

```
/.secrets/
├── index.jsonld          ← AI reads this to understand the structure
├── github/
│   ├── personal.json     ← Personal GitHub token
│   └── work.json         ← Work GitHub token
├── openai/
│   └── default.json      ← OpenAI API key
└── aws/
    ├── prod.json         ← Production AWS credentials
    └── dev.json          ← Development AWS credentials
```

### Secret Store Index

The `index.jsonld` file describes the secret store structure:

```json
{
  "@context": "https://undefineds.co/ns/",
  "@type": "SecretStore",
  "description": "Pod credential storage",
  
  "services": [
    {
      "@type": "ServiceConfig",
      "service": "https://github.com",
      "label": "GitHub",
      "path": "github/",
      "supportedTypes": ["GitHubToken", "GitHubOAuth"],
      "namingHint": "{purpose}.json"
    },
    {
      "@type": "ServiceConfig", 
      "service": "https://api.openai.com",
      "label": "OpenAI",
      "path": "openai/",
      "supportedTypes": ["OpenAIKey"],
      "namingHint": "{name}.json"
    },
    {
      "@type": "ServiceConfig",
      "service": "https://aws.amazon.com",
      "label": "AWS",
      "path": "aws/",
      "supportedTypes": ["AWSCredential"],
      "namingHint": "{environment}.json"
    }
  ],
  
  "purposes": ["personal", "work", "prod", "dev", "test"],
  
  "credentials": [
    { "@id": "github/personal.json", "label": "GitHub 个人账号", "purpose": "personal" },
    { "@id": "github/work.json", "label": "GitHub 工作账号", "purpose": "work" },
    { "@id": "openai/default.json", "label": "OpenAI 默认密钥" },
    { "@id": "aws/prod.json", "label": "AWS 生产环境", "purpose": "prod" }
  ]
}
```

### AI Workflow

When a user says "save this GitHub token, it's for personal use":

1. **Read Index**: `GET /.secrets/index.jsonld`
2. **Find Service**: Match "GitHub" → `services[0]`
3. **Determine Path**: `path` = `github/`, `namingHint` = `{purpose}.json` → `github/personal.json`
4. **Check Existing**: Look in `credentials` to avoid overwriting
5. **Write Credential**:
   ```json
   {
     "@type": ["Credential", "GitHubToken"],
     "label": "GitHub 个人账号",
     "purpose": "personal",
     "service": "https://github.com",
     "token": "ghp_xxx"
   }
   ```
6. **Update Index**: Add new entry to `credentials` array

### Information AI Needs

| Information | Source | Purpose |
|-------------|--------|---------|
| Service list | `services[]` | Know which services are configured |
| Path rules | `path` + `namingHint` | Know where to store |
| Credential types | `supportedTypes` | Know which schema to use |
| Purpose enum | `purposes` | Know how to classify |
| Existing credentials | `credentials[]` | Avoid overwriting |

---

## Security Considerations

1. **ACL Protection**: The `/.secrets/` container MUST have restrictive ACL:
   ```turtle
   </alice/.secrets/.acl> a acl:Authorization ;
       acl:agent </alice/profile/card#me> ;
       acl:accessTo </alice/.secrets/> ;
       acl:default </alice/.secrets/> ;
       acl:mode acl:Read, acl:Write, acl:Control .
   ```

2. **Agent Authorization**: Grant Agents read access only to specific credentials:
   ```turtle
   </alice/.secrets/github.json.acl> a acl:Authorization ;
       acl:agent </alice/agents/code-agent/profile#me> ;
       acl:accessTo </alice/.secrets/github.json> ;
       acl:mode acl:Read .
   ```

3. **Token Rotation**: Use `udf:expiresAt` to track token expiry and implement rotation.

4. **Encryption**: Consider encrypting token values at rest (implementation-specific).

---

## Changelog

- **2024-12-12**: Add SecretStore, ServiceConfig, AI workflow documentation
- **2024-12-12**: Initial draft
