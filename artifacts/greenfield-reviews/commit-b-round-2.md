# Commit B review — round 2

## Required finding

**Blocker:** the round-1 CSV regression delta was not credible attested evidence because it referenced `e334426b3c`, not reviewed HEAD `72de684886`, and did not preserve raw parent/current commands, outputs, or exit codes. Preserve both raw runs and generate the delta from those outputs.

Status: **not approved** pending evidence repair.
