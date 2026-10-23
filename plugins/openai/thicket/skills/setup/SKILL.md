---
name: setup
description: Set up the Thicket plugin after it is installed. Confirm the connection, say which organizations it covers, and show what the person can ask Thicket for. Use when the person chooses Set up for Thicket or asks to set up Thicket.
---

# Set up Thicket

1. Call `whoami`. If the call fails because Thicket is not connected, ask the person to connect: ChatGPT opens Thicket in their browser, they sign in and pick Read-only access or Full access. Then call `whoami` again.
2. Call `list_organizations` and tell the person which organizations the connection covers, with each one's name and their role in it. If there are several, ask which one to work in by default and keep to it for this conversation.
3. Show what they can ask for, as a few examples that use their own project names from `list_projects`:
   - "What's due this week in <project>, and who has it?"
   - "Summarize the comments on <a message> and list the open questions."
   - "Turn these meeting notes into to-dos on <a list> and assign them."
   - "Draft a Friday update for <project> from the to-dos we finished this week."
   - "Log an hour and a half on <a to-do> for yesterday."
4. Explain the access boundaries: ChatGPT sees and does only what the person can in Thicket, with Read-only access or Full access as they approved it. Changes are made under their name and may notify other people. They can disconnect at any time from My settings, Connected apps, in Thicket.

Keep it to one short message, then wait for what they want to do first.
