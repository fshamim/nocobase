/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T-R1 (R1-3): the ONE shared wrapper for every interactive element rendered
 * inside a table cell — clicks and key presses stop here so they never bubble
 * into the row\'s open-drawer handler (the legacy page used the same pattern).
 */

import React from 'react';

export function CellInteractive({ children }: { children: React.ReactNode }) {
  return (
    <span
      role="presentation"
      style={{ display: 'contents' }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  );
}
