/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

const normalizeName = (item: unknown): string | null => {
  if (typeof item === 'string' && item.trim()) {
    return item;
  }
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    if (typeof record.name === 'string' && record.name.trim()) {
      return record.name;
    }
  }
  return null;
};

const normalizeTool = (item: unknown, defaultAutoCall = false): { name: string; autoCall: boolean } | null => {
  const name = normalizeName(item);
  if (!name) {
    return null;
  }
  return {
    name,
    autoCall: typeof item === 'string' ? defaultAutoCall : (item as Record<string, unknown>).autoCall === true,
  };
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function normalizeSkillSettings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const input = value as Record<string, any>;
  const nextSkills: string[] = [];
  const nextTools = new Map<string, { name: string; autoCall: boolean }>();

  for (const item of Array.isArray(input.skills) ? input.skills : []) {
    if (typeof item === 'string' && item.trim()) {
      if (!nextSkills.includes(item)) {
        nextSkills.push(item);
      }
      continue;
    }
    const tool = normalizeTool(item);
    if (!tool) {
      continue;
    }
    const existing = nextTools.get(tool.name);
    nextTools.set(tool.name, {
      name: tool.name,
      autoCall: tool.autoCall || existing?.autoCall === true,
    });
  }

  const defaultToolAutoCall = input.autoCall === true;
  for (const item of Array.isArray(input.tools) ? input.tools : []) {
    const tool = normalizeTool(item, defaultToolAutoCall);
    if (!tool) {
      continue;
    }
    const existing = nextTools.get(tool.name);
    nextTools.set(tool.name, {
      name: tool.name,
      autoCall: tool.autoCall || existing?.autoCall === true,
    });
  }

  return {
    ...input,
    skills: nextSkills,
    tools: Array.from(nextTools.values()),
  };
}

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    let updatedEmployees = 0;
    const employeesRepo = this.db.getRepository('aiEmployees');
    const employees = await employeesRepo.find({});

    for (const row of employees) {
      const skillSettings = row.get?.('skillSettings') ?? row.skillSettings;
      const nextSkillSettings = normalizeSkillSettings(skillSettings);
      if (sameJson(skillSettings, nextSkillSettings)) {
        continue;
      }
      await row.update({ skillSettings: nextSkillSettings });
      updatedEmployees += 1;
    }

    let updatedConversations = 0;
    const conversationsRepo = this.db.getRepository('aiConversations');
    const conversations = await conversationsRepo.find({});

    for (const row of conversations) {
      const options = row.get?.('options') ?? row.options;
      if (!options || typeof options !== 'object' || Array.isArray(options) || !options.skillSettings) {
        continue;
      }
      const nextSkillSettings = normalizeSkillSettings(options.skillSettings);
      if (sameJson(options.skillSettings, nextSkillSettings)) {
        continue;
      }
      await row.update({
        options: {
          ...options,
          skillSettings: nextSkillSettings,
        },
      });
      updatedConversations += 1;
    }

    if (updatedEmployees > 0 || updatedConversations > 0) {
      this.app.logger.info(
        `Normalized AI skill settings: aiEmployees=${updatedEmployees}, aiConversations=${updatedConversations}`,
      );
    }
  }
}
