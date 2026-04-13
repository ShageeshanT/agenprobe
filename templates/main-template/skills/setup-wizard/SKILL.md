---
name: Setup Wizard
slug: setup-wizard
version: 1.0.0
description: "Handles first-time bot setup from a template zip. When someone sends a template package and asks to install it, this skill guides the conversation: extracts the zip, asks for each placeholder value one by one, replaces all placeholders, installs the plugin, copies workspace files, and restarts the bot. Use when: the owner or tech team sends a .zip file and says 'install', 'set up', 'configure', or 'deploy this template'."
metadata: {"openclaw":{"always":false}}
---

# Setup Wizard

You are setting up a new bot from a template package. Follow these steps EXACTLY. Do not skip any step. Ask ONE question at a time and wait for the answer before moving on.

## When This Triggers

This skill activates when:
- Someone sends a `.zip` file AND their message contains words like "install", "set up", "configure", "deploy", or "use this template"
- The sender must be an admin or tech team member (check `<agentdb-context>` for access_level = "admin")
- If the sender is NOT admin, respond: "Template installation requires admin access. Please ask the owner or tech team to do this."

## Step 1: Verify Permissions

Before doing anything:
1. Check `<agentdb-context>` for the sender's access level.
2. If not admin: "Template installation requires admin access." STOP.
3. If admin: proceed.

## Step 2: Save and Extract the Zip

1. The zip file was saved to the workspace when it was received.
2. Run: `exec("mkdir -p /tmp/agentprobe-template && unzip -o <path-to-zip> -d /tmp/agentprobe-template")`
3. Run: `exec("ls /tmp/agentprobe-template/")` to see what's inside.
4. Confirm to the user: "I've extracted the template. Let me set it up for you. I'll ask a few questions one at a time."

## Step 3: Ask for Placeholder Values

Ask these questions ONE AT A TIME. Wait for each answer before asking the next.

### Question 1: Agent Name
"What would you like to call me? This is the name your customers will see. (Example: Aria, Nova, Atlas)"

Save the answer as `AGENT_NAME`.

### Question 2: Business Name
"What is your business name? (Example: TechCorp Solutions)"

Save as `BUSINESS_NAME`.

### Question 3: Business Description
"In one sentence, what does {{BUSINESS_NAME}} do? (Example: We provide IT consulting and managed services)"

Save as `BUSINESS_DESCRIPTION`.

### Question 4: Business Short Pitch
"Give me a one-line pitch — what I should say when a customer asks what you do. (Example: We help businesses streamline their IT operations)"

Save as `BUSINESS_SHORT_PITCH`.

### Question 5: Owner Name
"What is the owner's name? This is who I escalate important decisions to."

Save as `OWNER_NAME`.

### Question 6: Owner Phone
"What is the owner's WhatsApp number? Include the country code. (Example: +94771234567)"

Save as `OWNER_PHONE`.

### Question 7: Timezone
"What timezone should I use? (Example: Asia/Colombo, America/New_York, Europe/London)"

Save as `TIMEZONE`.

### Question 8: SLA Hours
"How many hours should I wait before escalating an unanswered quotation request? (Default: 4)"

Save as `SLA_HOURS`. If they say "default" or don't have a preference, use "4".

## Step 4: Confirm All Values

Show the user a summary:

```
Here's what I'll set up:

Agent Name: [AGENT_NAME]
Business: [BUSINESS_NAME]
Description: [BUSINESS_DESCRIPTION]
Pitch: [BUSINESS_SHORT_PITCH]
Owner: [OWNER_NAME] ([OWNER_PHONE])
Timezone: [TIMEZONE]
Quotation SLA: [SLA_HOURS] hours

Does this look correct? (yes/no)
```

If no: ask which value to change, update it, re-confirm.
If yes: proceed to installation.

## Step 5: Replace Placeholders and Install

Run the installation script with all the collected values. Execute these commands in order:

```bash
# 1. Replace placeholders in all template files
cd /tmp/agentprobe-template

# Find all text files and replace placeholders
find . -type f \( -name "*.md" -o -name "*.json" -o -name "*.env" \) -exec sed -i \
  -e 's/{{AGENT_NAME}}/[AGENT_NAME]/g' \
  -e 's/{{BUSINESS_NAME}}/[BUSINESS_NAME]/g' \
  -e 's/{{BUSINESS_DESCRIPTION}}/[BUSINESS_DESCRIPTION]/g' \
  -e 's/{{BUSINESS_SHORT_PITCH}}/[BUSINESS_SHORT_PITCH]/g' \
  -e 's/{{OWNER_NAME}}/[OWNER_NAME]/g' \
  -e 's/{{OWNER_PHONE}}/[OWNER_PHONE]/g' \
  -e 's/{{TIMEZONE}}/[TIMEZONE]/g' \
  -e 's/{{SLA_HOURS}}/[SLA_HOURS]/g' \
  {} \;
```

**IMPORTANT:** In the sed commands above, replace `[AGENT_NAME]` etc. with the ACTUAL values the user gave you, properly escaped for sed (escape `/`, `&`, `\` characters).

```bash
# 2. Copy workspace files
WORKSPACE=$(grep -oP '"workspace"\s*:\s*"\K[^"]+' /tmp/agentprobe-template/openclaw.json 2>/dev/null || echo "$HOME/.openclaw/workspace")
mkdir -p "$WORKSPACE"
cp /tmp/agentprobe-template/SOUL.md "$WORKSPACE/"
cp /tmp/agentprobe-template/MEMORY.md "$WORKSPACE/"
cp /tmp/agentprobe-template/IDENTITY.md "$WORKSPACE/"
cp /tmp/agentprobe-template/HEARTBEAT.md "$WORKSPACE/"
cp /tmp/agentprobe-template/TOOLS.md "$WORKSPACE/"
cp /tmp/agentprobe-template/AGENTS.md "$WORKSPACE/"
cp /tmp/agentprobe-template/USER.md "$WORKSPACE/"
cp -r /tmp/agentprobe-template/workspace/.learnings "$WORKSPACE/"
cp -r /tmp/agentprobe-template/workspace/memory "$WORKSPACE/"
cp -r /tmp/agentprobe-template/workspace/.config "$WORKSPACE/"

# 3. Install AgentDB plugin
PLUGIN_DIR="$HOME/.openclaw/plugins/agentdb"
mkdir -p "$PLUGIN_DIR"
cp -r /tmp/agentprobe-template/plugins/agentdb/* "$PLUGIN_DIR/"
cd "$PLUGIN_DIR" && npm install --production 2>&1

# 4. Install self-improving skill
SKILL_DIR="$HOME/self-improving"
mkdir -p "$SKILL_DIR"
cp -r /tmp/agentprobe-template/skills/self-improving/* "$SKILL_DIR/"

# 5. Copy openclaw.json (CAREFUL — backup existing first)
CONFIG_PATH="$HOME/.openclaw/openclaw.json"
if [ -f "$CONFIG_PATH" ]; then
  cp "$CONFIG_PATH" "${CONFIG_PATH}.bak.pre-template"
fi
cp /tmp/agentprobe-template/openclaw.json "$CONFIG_PATH"

# 6. Clean up
rm -rf /tmp/agentprobe-template
```

After each command group, check the exit code. If any step fails, tell the user which step failed and what the error was. Do not continue past a failed step.

## Step 6: Add Owner as First Contact

After installation, add the owner to AgentDB:

```
contact_add:
  name: [OWNER_NAME]
  phone: [OWNER_PHONE]
  role: owner
  access_level: admin
  comm_style: detailed
```

## Step 7: Ask About Forwarders

"Your bot is set up! Now let's add your team. Who should receive customer quotation requests? Give me their name and WhatsApp number, one at a time. Say 'done' when you've added everyone."

For each forwarder:
```
contact_add:
  name: [name]
  phone: [phone]
  role: forwarder
  access_level: team
  comm_style: detailed
```

After each: "Added [name] as a forwarder. Anyone else? (or say 'done')"

## Step 8: Confirm Setup Complete

"Setup complete! Here's what I installed:

- Agent name: [AGENT_NAME]
- Business: [BUSINESS_NAME]
- AgentDB plugin with contact safety
- Self-improving skill for learning
- [N] forwarder(s) added to the team
- Owner ([OWNER_NAME]) set as admin

I'm ready to start helping your customers. When someone messages, I'll greet them, gather their requirements, and forward to your team for quotation.

The bot may need a restart for all config changes to take effect. Would you like me to restart now?"

If yes: run `exec("openclaw gateway restart")` or signal a restart.

## Error Handling

- If the zip doesn't contain expected files (no SOUL.md): "This doesn't look like a valid template package. It should contain SOUL.md, MEMORY.md, and other template files."
- If npm install fails: "The AgentDB plugin installation failed. The tech team may need to check the server's Node.js setup."
- If file copy fails: "I couldn't write to the workspace directory. The tech team may need to check file permissions."
- Always tell the user what went wrong in plain language. Never show raw error dumps.

## Security Note

- Only admin-level contacts can trigger this skill.
- The zip contents are extracted to /tmp and cleaned up after installation.
- The openclaw.json backup is saved as .bak.pre-template in case rollback is needed.
- This skill does NOT handle API keys or tokens in the interactive flow — those are set separately by the tech team in openclaw.json.
