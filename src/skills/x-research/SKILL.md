---
name: x-research
description: Research current X/Twitter discussion when the user explicitly asks to search X/Twitter or analyze discussion or sentiment on X.
status: stable
requires:
  tools:
    - x_search
---

# X research

## Use when

Use this Skill only when the user explicitly identifies X, Twitter, tweets, or X-specific sentiment/discussion.

Do not activate it for general requests such as “What are investors saying?”, “What is the market reaction?”, or “What is online sentiment?” unless the user specifies X/Twitter.

Examples:
- Use: “Search X for reactions to this earnings release.” “What are people on Twitter saying?” “Analyze X sentiment around this announcement.”
- Do not use: “What are investors saying?” “What is the market reaction?” “What is online sentiment?”

## Outcome

Use `x_search` to produce a sourced summary of current X discussion about the requested topic. Establish a relevant time window and report it. Search only as broadly as needed to answer the question.

## Evidence rules

- Separate observed posts and factual claims from your interpretation of sentiment.
- Do not present sampled posts as representative polling or broad public opinion.
- Do not invent post counts, engagement, trends, quotations, or account identities.
- State when evidence is sparse, repetitive, coordinated, or otherwise biased.
- Treat factual claims in posts as unverified unless corroborated by an appropriate source.

## Output

Summarize the search scope and time window, the main observed themes with links or account attribution, material disagreement, and an evidence-quality caveat. Describe sentiment qualitatively; do not create a sentiment score.

## Completion criteria

The requested X scope was searched, observations are traceable to returned posts, interpretation is labeled, and sample limitations are explicit.
