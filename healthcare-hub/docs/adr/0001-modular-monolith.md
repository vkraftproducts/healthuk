# ADR 0001: Modular monolith

Status: Accepted. Context: pilot scale (500 jobs/day), small budget, need strong
transactional consistency for allocation gates. Decision: single NestJS API + one worker,
domain modules with no cross-module DB access except via module services. Consequences:
cheapest hosting, simple deploys; extract modules later if scale requires.
