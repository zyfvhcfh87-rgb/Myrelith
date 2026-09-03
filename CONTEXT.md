# Myrelith domain language

## Nested sequences

- **Sequence definition**: one centrally owned `TimelineDoc` in a project. Its
  tracks and timeline items are shared by every instance that references it.
- **Sequence instance**: one timeline item that references a sequence
  definition and maps a contiguous parent range to an equal-length source
  range in that definition.
- **Root sequence**: the project sequence selected as the final program output.
- **Active sequence**: the sequence definition currently open for editing. It
  is session state and does not change the root sequence.
- **Independent sequence instance**: an instance retargeted to a newly cloned
  definition graph, so later edits no longer affect the original shared graph.
