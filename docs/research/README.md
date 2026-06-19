# Research & design notes

Committed, in-the-open notes behind Vermeil's features — what was investigated,
what the constraints are, and why the design went the way it did. These are part
of the repo on purpose: this is an open project, so the reasoning is public, not
just the code.

## Layout

- One subfolder per feature/topic (e.g. `ingame-capes/`).
- A folder may hold a `research.md` (findings), a `poc.md` (proof-of-concept
  scope), and whatever else helps — design sketches, open questions, decisions.

## Ground rules

- **Original.** Everything is written in our own words from official
  documentation and specifications, cited inline where it matters. Third-party
  *services and APIs* (Fabric, NeoForge, Quilt, Mojang, the Minecraft Wiki,
  Architectury, Adoptium, Modrinth, CurseForge) are named normally. Another
  launcher's, client's, or mod's *source code* is never a reference.
- **Honest about uncertainty.** If something needs verifying before building,
  it's listed as an open question, not stated as fact.
- These notes inform the code; when a decision lands, the code and its commit
  message are the source of truth.
