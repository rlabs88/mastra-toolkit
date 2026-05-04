---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
agent_harness: all
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

### Important pointers
- Your user appreciate hard and well thought out questions. Never ask easy
questions that suggests specific answer. Ask well reserached, well thoughtout
questions.

- Ask 1 questions at a time.
- NEVER give Recommended answers
- NEVER do a yes/no question
- Unless user prompts for suggestions, NEVER provide multiple choices
- You may provide multiple choice when user ask for suggestions. BUT - Each
Choice Must be Unique
  - Avoid choice 1, choice 2, choice 3 where choice 3 is hybrid of 1 and 2
  - Avoid hybrid choices - each presented choices are completely unique
  - Prompt user to select single or multiple choices if it makes sense.
