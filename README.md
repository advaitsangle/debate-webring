## Joining the debate webring

Thanks for applying! Please fill in the fields below. A maintainer will review and merge if everything looks good.

---

**Full name:**

**Website URL:**

**Debate club / organisation (current or former):**

**Location (city, country):**

**Site description** (1–2 sentences — this is what shows up on the webring page):

**Verification link** (Tabroom profile, tournament result, club membership page, season record, or anything that shows you competed — we do human review so don't overthink this):

---

**Checklist**

- [ ] I've added my entry to the end of the `SITES` array in `sites.js`
- [ ] My site is live and accessible at the URL above, and links back to the webring

---

*Once merged, your site will appear in the ring automatically and your `/next` and `/prev` links will start working.*

---

## How the constellation map works

The ring visualisation on the homepage isn't a static image — it's a tiny physics simulation that runs live in your browser every time the page loads.

When the page first opens, JavaScript places every site as a particle in 2D space, then runs 120 iterations of a repulsion-only force simulation: nodes push each other apart like same-charge magnets, while a soft gravity pulls the whole cloud back toward the centre. The result is an organic scattered layout — no two arrangements look the same for a different number of sites.

The clever part is what happens next. A nearest-neighbour algorithm (a lightweight TSP heuristic) traces a short path through all the scattered positions, then *assigns* ring members to positions along that path. This means your immediate neighbours in the ring — the people you link to as `prev` and `next` — tend to end up physically close to you on the map, so the lines between them stay short rather than cutting across the whole canvas.

The whole simulation is seeded (so the layout is identical for every visitor) and cached after the first run (~2ms), so it never runs twice in the same session. Scale=1 is computed from the actual viewport size so the whole graph always fits in frame on load, no matter how large or small the ring grows.



