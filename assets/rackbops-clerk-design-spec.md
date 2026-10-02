# Rackbops Clerk -- Docket Mascot Design Specification

Canonical visual reference: `rackbops-clerk.png`, the fantasy clerk concept generated and positively received on 2026-10-01 in the Docket mascot conversation.

Product: Docket task tracker / Rackbops Clerk Discord instance.

Role: Primary character mascot and approachable face of the task-tracking service.

Status: Approved visual direction; this specification records the first concept. Production derivatives, favicon, and pose sheet are not yet created.

## 1. Character identity

Rackbops Clerk is a small fantasy town clerk: an attentive, discreet, quietly resourceful goblin-like steward who remembers what people asked for, keeps the record, and returns with useful news. The character is friendly and capable, with a little whimsy and the satisfaction of a well-kept ledger.

The Clerk should feel welcoming, observant, organized, patient, trustworthy, and curious. Avoid bureaucratic officiousness, destructive goblin mischief, or a promise of unrestricted autonomous action.

## 2. Product meaning and scope

The design represents the service people encounter as **Rackbops Clerk**, across a modular implementation:

| Component | Purpose | Branding relationship |
|---|---|---|
| Rackbops/docket | Reusable tracker domain, scheduling, contracts, and task types | Core home of the Docket identity |
| Tracker plugin in Rackbops/rackbops-bot-plugins | Discord commands, people, persistence, notifications, and web area | Main user-facing use of the Clerk |
| Rackbops/rackbops-discord-bot | Generic modular bot host | Clerk identifies this tracker instance; does not replace the host's Luma mascot |
| Rackbops/docket-runner | Claims model jobs, runs the CLI, and returns results | Supporting implementation, not a separate personality |
| Lepid-Labs/city-hall | Queues and runs automated jobs, as described by Docket's documents | Infrastructure dependency; the Clerk does not claim to be its organization-wide mascot |
| Rackbops/discord-mcp | Delivers agent messages through Discord | Related delivery service, not the tracker itself |

The tracker covers reminders, renewals and expiries, price tracking, reviewed research, interest scouting, and want-list watching. Observe-and-notify is its baseline. Internal writes require grants; external or irreversible actions remain outside the current design.

## 3. Core silhouette

An oversized organic head, very broad pointed ears, a swept cream-white hair mass, and a compact clothed body define the character. A thick ledger forms a clear secondary silhouette beside the torso. The long navy coat and substantial brown boots ground the character as a working clerk.

Preserve both ear tips, the distinctive hair sweep, and the ledger's chunky rectangular shape. The character stands naturally; no levitation, crystalline armor, or robot anatomy.

## 4. Proportions

Use the image as the authority rather than enforcing a rigid model sheet. Approximate baseline: head including hair occupies about one third of body height, excluding the quill; ear span is roughly twice the central face width. Short torso, compact limbs, and oversized boots support an illustrated mascot silhouette. Avoid realistic adult anatomy or exaggerated infant proportions.

## 5. Face and expression

Skin is warm yellow-green, with muted peach inner ears and a softly pink nose. Large amber-gold eyes have dark pupils, clear highlights, and expressive dark brows. The mouth is a small, warm, closed smile. Keep the face open and readable; no tusks, threatening teeth, or exaggerated wrinkles.

Expressions include welcoming, focused, curious, pleased, gently concerned, and relieved. Errors should prompt a helpful, composed expression rather than panic or blame.

## 6. Hair and ears

Cream-white hair sweeps across the forehead in large, layered locks, with a few loose curls. Hair volume and recognizable forelock matter more than individual strands. Ears extend outward and slightly upward, with soft organic curves and warm inner surfaces. Preserve the organic distinction from the Artifact Gremlin's hard shard ears.

## 7. Clothing

Canonical clothing is a tailored navy clerk's coat with warm gold edging and brass buttons, burgundy waistcoat and neckcloth, cream shirt and broad turned cuffs, dark trousers, and brown buckled boots. A brown belt and small pouch complete the working outfit.

The costume suggests a fantasy civic office without a crown, military rank, judicial robes, or institutional insignia. Simplify buttons and folds at smaller sizes; preserve coat, neckcloth, and cuffs.

## 8. Signature objects

| Object | Construction | Meaning |
|---|---|---|
| Docket ledger | Thick brown leather cover, cream page block, brass corners and clasp, colored ribbon markers | Tasks, ownership, due dates, findings, and run history |
| Quill | Large cream feather with dark navy tip, tucked behind an ear | Research, recording, and useful reports |
| Key | One substantial old-fashioned brass key hanging at the belt | Entrusted access and responsibility within granted boundaries |

The ledger is the strongest secondary identity anchor. Key and quill may be omitted when space is limited. Never place real personal information or credentials in the ledger. These symbols are artistic interpretation, not architectural claims.

## 9. Materials and illustration treatment

Use polished cartoon illustration with clear dark outlines, broad color areas, restrained painterly or cel shading, and selective highlights. Skin is smooth and organic; cloth is matte; ledger, belt, and boots are worn leather; hardware is warm brass. Fine page lines and fabric folds belong only in larger illustrations.

The reference has more shaded detail than a strict flat icon. Small derivatives should be deliberately simplified rather than mechanically traced.

## 10. Core color palette

These are approximate production starting values inferred from the reference, not sampled brand tokens. The approved image governs visual matching.

| Role | Suggested color |
|---|---|
| Skin base | `#A7B84F` |
| Skin shadow | `#778B37` |
| Inner ear / nose warmth | `#CB8D73` |
| Hair / cream shirt | `#F3E4C7` |
| Hair shadow / parchment | `#CDBA98` |
| Coat navy | `#29364F` |
| Coat highlight | `#435575` |
| Waistcoat / neckcloth | `#7D3F35` |
| Leather | `#654431` |
| Dark trousers / outline | `#302922` |
| Brass / eye gold | `#D7A442` |
| Brass highlight | `#F5D580` |

Keep yellow-green skin, cream hair, navy coat, burgundy accents, and warm brass together. Avoid neon gradients and glowing eyes.

## 11. Contrast and lighting

The face must read first, followed by the ledger and costume. Separate cream hair from pale backgrounds with a dark outline; separate navy clothing from dark backgrounds with visible midtones and a restrained edge highlight or keyline. Keep pupils distinct from the amber irises.

Lighting should be soft and warm, with controlled highlights on brass and leather. Do not rely on bloom or a dark vignette to define the silhouette.

## 12. Hands and gestures

Small organic hands hold the ledger convincingly, with a consistent finger construction across derivatives. Use open-palm greetings, pointing to a task, writing, presenting a finding, or a modest celebratory gesture. Avoid claws, weapons, accusatory pointing, and impossible grip anatomy.

## 13. Canonical pose

Standing in a relaxed three-quarter view, smiling toward the viewer, holding the closed ledger against the torso. Quill behind the ear, key at the belt, other arm resting naturally. Preserve this as the baseline reference before developing variants.

## 14. Allowed pose variation

| Pose | Visual action | Suitable use |
|---|---|---|
| Welcome | Open palm or small wave, ledger retained | Registration and onboarding |
| Reminder | Indicate a ribbon-marked ledger entry | Due tasks and reminders |
| Research | Consult the open ledger or write with quill | Research progress and findings |
| Scout | Look attentively beyond the ledger | Interests and want-list updates |
| Price finding | Present one simple result card | Price alerts; no purchase implication |
| Completed | Close ledger with a pleased expression | Completion and history |
| Waiting | Hold ledger patiently | Pending work or quiet empty states |
| Concerned | Inspect an entry, gently raised brow | Failure, missing information, or retry |

Extra props are optional and subordinate. No shopping carts, piles of coins, or imagery implying purchases are automatically made.

## 15. Identity elements that must remain consistent

Preserve organic yellow-green skin, broad pointed ears, cream-white swept hair, amber eyes, navy and burgundy clerk clothing, and the leather ledger. In a full-body derivative, retain brass hardware and grounded boots. The ledger, hair, and face silhouette should survive most simplifications.

## 16. Hero illustration guidance

Use a master at least 1024 pixels on the short edge. Show the full character and props, with room around ears, quill, and boots. The current reference is a 1024x1536 portrait. Square compositions require a deliberate new layout, not a crop that cuts off identifying parts.

Use full-body art for introductions, documentation, or a mascot sheet. Keep surrounding scenery minimal.

## 17. Medium illustration guidance

For 256-768 px display, simplify hair strands, cloth folds, ledger page lines, buckles, and buttons. Keep face, hair mass, ear shape, coat color, and ledger unmistakable. One meaningful gesture is enough.

## 18. Discord avatar guidance

Create a dedicated square head-and-upper-torso composition at 512x512 or larger. Keep both ear tips within Discord's circular crop and leave outer safe space. Show a small portion of the ledger if it remains legible. Quill may be reduced or omitted. Test at 128, 64, and 32 px.

Use a solid navy or warm cream backing when a transparent silhouette is hard to see. Background choice must preserve face and hair contrast.

## 19. Sticker guidance

Use a true transparent cutout with a clean silhouette and an optional contrasting outer keyline. Reduce fine details while keeping the character's organic warmth. Good sticker poses are wave, reminder, reading, reporting, completion, and patient waiting. Keep captions separate so the artwork can be reused.

## 20. Favicon guidance

Do not shrink the complete figure to 16x16. Use a separately drawn compact head mark at 32-64 px: green face, broad ears, cream forelock, minimal eyes. At 16 px, test a simplified closed ledger with a brass clasp as an alternative. Selection remains open until both are inspected at actual size.

No favicon asset has been delivered with this specification.

## 21. Background and transparency

Preferred backgrounds are restrained warm cream, deep navy, or a true transparent cutout. Avoid busy offices, civic buildings, paper storms, sparkles, and dramatic magical effects.

The generated reference was requested with transparency and is RGBA, but channel inspection shows alpha values from 0 to 254. It also visibly includes a dark atmospheric surround. It is a visual reference, not a verified clean production cutout. A future cutout must remove the surrounding atmosphere while preserving the character, then be checked on white, navy, and a checkerboard.

## 22. Light and dark theme adaptation

On light themes, use strong navy outlines and modest shadows around cream hair and cuffs. On dark themes, lift coat midtones or add a restrained light keyline. Preserve costume and skin colors; do not recolor the character to match every theme. Avoid halos that muddy the edge.

## 23. Do

- Keep the Clerk approachable, alert, discreet, and competent.
- Preserve the face, forelock, ears, and ledger across poses.
- Use warm brass, matte fabric, and leather materials.
- Simplify deliberately for icons and circular avatars.
- Keep product status and actionable information in accessible text beside the artwork.
- Use descriptive alt text when the character conveys meaning, and empty alt text when decorative.

## 24. Do not

- Turn the Clerk into the Artifact Gremlin, Luma, Bop, or Chanel.
- Add crystalline skin, neon eyes, robotic parts, wings, weapons, crowns, or official seals.
- Make the character malicious, childish, pompous, or chaotic.
- Put private task details or readable credentials in artwork.
- Imply automatic purchases or unrestricted access through poses or props.
- Treat a reference image as a finished favicon or verified transparent asset.

## 25. Reusable generation prompt

Use the approved first concept as an image reference whenever possible.

> Create a new illustration of Rackbops Clerk, the established fantasy mascot of the Docket task tracker and its Rackbops Clerk Discord instance. Preserve the reference character: a small friendly organic goblin-like town clerk with warm yellow-green skin, very broad outward-pointing ears with peach inner surfaces, an oversized head, swept cream-white layered hair, expressive amber-gold eyes with dark pupils, dark brows, a softly pink nose, and a gentle closed smile. Use a tailored navy coat with warm gold edging and brass buttons, burgundy waistcoat and neckcloth, cream shirt and broad cuffs, dark trousers, brown belt and substantial buckled leather boots. Retain the thick brown leather docket ledger with cream pages, brass corners and clasp, and ribbon markers. Include a cream feather quill with a navy tip behind an ear and one old-fashioned brass key at the belt where scale allows. The character is attentive, discreet, organized, quietly resourceful, and welcoming. Use polished cartoon illustration with crisp dark outlines, broad readable shapes, restrained shading, warm brass highlights, and strong contrast. Preserve the reference face, hair, costume, and ledger; change only the requested pose and composition. Pose: [INSERT ACTION]. Composition: [FULL BODY / MEDIUM / SQUARE AVATAR], with all necessary identifying features safely inside the frame. Background: [TRUE TRANSPARENT CUTOUT / SOLID NAVY / WARM CREAM]. For transparency, exclude any vignette, haze, floor shadow, or surrounding atmosphere. No text, watermark, logos, extra characters, weapons, crowns, crystalline armor, neon glow, or unrelated props.

## 26. Regeneration and acceptance checks

Before accepting a derivative, inspect face identity, ear tips, forelock, palette, ledger construction, hand anatomy, and the requested gesture. Check intended display size and circular crop where relevant. For cutouts, verify actual alpha and inspect edges on both light and dark surfaces. Keep each accepted variant versioned; do not overwrite the original concept.

The first concept was generated with the built-in image-generation tool. No new image generation is part of this write-up.

## 27. Canonical priority and provenance

When simplifying, preserve in this order:

1. Face silhouette, broad organic ears, and cream forelock.
2. Yellow-green skin and amber eyes.
3. Ledger, where the composition includes the torso.
4. Navy coat, burgundy neckcloth, and cream cuffs.
5. Warm brass accents.
6. Quill, key, boots, and fine costume detail.

Specification format follows [Artifact Gremlin](https://github.com/Rackbops/artifact-console/blob/main/assets/artifact-gremlin-design-spec.md) and [Chanel](https://github.com/Rackbops/research-triage/blob/main/assets/research-triage-mascot-design-spec.md).

Product grounding, read 2026-10-01:

- [Docket purpose](https://github.com/Rackbops/docket/blob/main/docs/PURPOSE.md), blob `5527550bfea0d3b7548e1a88a6364b712766a92e`.
- [Docket runner purpose](https://github.com/Rackbops/docket-runner/blob/main/docs/PURPOSE.md), blob `aeb1a5f934cd7f066e6d9edb0f82b17ff7373448`.
- [Discord bot purpose](https://github.com/Rackbops/rackbops-discord-bot/blob/main/PURPOSE.md).
- [Discord MCP purpose](https://github.com/Rackbops/discord-mcp/blob/main/docs/PURPOSE.md).
- [Plugin host documentation](https://github.com/Rackbops/rackbops-bot-plugins/blob/main/README.md).
- [Cross-repo tracker goal and plan](https://github.com/Rackbops/Tooling/blob/main/research/city-hall-task-tracker.md), section 0, blob `a48579a7348fbdda6b1737e2d08065f9c74db7ec`.

City-hall's own purpose file was not accessible through the connected repository reader; its role above is grounded in Docket, docket-runner, and the cross-repo plan. Costume, symbolism, and palette are design decisions, not requirements stated by those source documents.
