# Conversation Inspector - Improvements & Learnings

## 2026-01-19: Debugging AI-Generated Code with Conversation History

### The Problem
AI generated code with a subtle bug: `serializeRawData()` was cherry-picking 5 fields instead of serializing the entire API response object.

Original (buggy):
```java
private String serializeRawData(TransactionItem tx) {
    Map<String, Object> data = new HashMap<>();
    data.put("creditorName", tx.getCreditorName());
    data.put("debtorName", tx.getDebtorName());
    data.put("merchantCategoryCode", tx.getMerchantCategoryCode());
    data.put("bankTransactionCode", tx.getBankTransactionCode());
    data.put("additionalInformation", tx.getAdditionalInformation());
    return objectMapper.writeValueAsString(data);
}
```

Fixed:
```java
private String serializeRawData(TransactionItem tx) {
    return objectMapper.writeValueAsString(tx);  // Entire object!
}
```

### Investigation Process (How to Debug AI Reasoning)

1. **Find relevant sessions**:
   ```bash
   grep -l "BankSyncService\|relevant-keyword" ~/.claude/projects/*project*/*.jsonl
   ```

2. **Check file modification timestamps**:
   ```bash
   ls -la ~/.claude/projects/-Users-.../*.jsonl | grep -E "session-ids"
   ```

3. **Find file history backups**:
   ```bash
   find ~/.claude/file-history -name "file-hash@v*"
   ```

4. **Compare versions to see evolution**:
   ```bash
   grep -A30 "method_name" ~/.claude/file-history/session-id/file-hash@v2
   grep -A30 "method_name" ~/.claude/file-history/session-id/file-hash@v5
   ```

5. **Find the original prompt** (most valuable!):
   - Look for docs like `IMPLEMENTATION_PROMPT.md` in the project
   - Search for user messages in JSONL files
   - Check context summaries

### Root Cause Found

The original prompt said:
```
Store raw API responses in raw_payload column for debugging
```

AI interpreted "raw API responses" as "extra fields for debugging" instead of "complete response backup".

### Lessons Learned

1. **Ambiguous prompts lead to logical but wrong interpretations**
   - "raw API responses" could mean complete response OR extra metadata
   - AI chose space-optimized interpretation

2. **Be explicit in prompts**:
   ```diff
   - Store raw API responses in raw_payload column for debugging
   + Store the COMPLETE API response JSON in raw_data column.
   + Serialize the entire TransactionItem object, not just selected fields.
   + Purpose: full audit trail, future-proofing, re-processing capability.
   ```

3. **The Autonomy vs Clarification Trade-off**:
   - Modern AI models are more autonomous (good!)
   - To avoid 100 stupid questions, AI makes assumptions (necessary!)
   - But this means user MUST be involved in architecture brainstorming
   - Code generation can be delegated; architecture decisions should not

4. **Recommended workflow**:
   - Planning phase: User + AI brainstorm together (be present!)
   - Implementation: AI generates code autonomously
   - Review: AI runs tests in TDD loop
   - Quality gate: Hostile CTO review until pass
   - Understanding: User must deeply understand generated code for precise future requirements

### Feature Ideas for conversation-inspector

1. **"Why did you write this?" tool** - Given a code snippet, find the session and prompt that generated it

2. **Diff-to-prompt correlation** - Show which user prompt led to which code changes

3. **Assumption tracker** - Log when AI makes assumptions vs asks clarification

4. **Architecture decision log** - Separate from code changes, track design decisions made

---

## Notes

The intellij-debugger MCP is brilliant for code walkthroughs - AI can step through code with actual debugging to explain to users. This helps bridge the understanding gap when AI generates complex code.
