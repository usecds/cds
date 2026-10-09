# @usecds/collections

Recommended rules for common CDS collections, as target definitions a site's target extends one
by one. They are recommendations: CDS lists what doesn't follow them in the content report, and
they never fail a publish. A site that needs a rule to hold adds it to its own target's
`collections`.

| Definition | Collection | Recommends |
| --- | --- | --- |
| `@usecds/collections/posts` | `posts` | `slug` (lowercase, hyphenated), `status`, `coverImage`, `dateCreated`; texts `title` (up to 60 characters), `intro`, `content` |
| `@usecds/collections/faqs` | `faqs` | `status`, at least one of `groups` (`faq_groups` ids); texts `question` (up to 200 characters), `answer` |
| `@usecds/collections/faq_groups` | `faq_groups` | `status`; text `name` (up to 80 characters) |
| `@usecds/collections/videos` | `videos` | `status`, `provider`, `videoId`; text `description` |

`status` is one of `published`, `draft`, `archived`.

## Use

Install the package next to `@usecds/server` and list the definitions the site needs:

```json
{
  "id": "website",
  "extends": ["@usecds/collections/posts", "@usecds/collections/faqs"],
  "collections": {
    "posts": { "minItems": 1 }
  }
}
```

`loadTargets` merges the extended definitions first, then the target's own rules, additively:
schemas must all pass, and the stricter limit wins. See [docs/server.md](../docs/server.md#targets).
