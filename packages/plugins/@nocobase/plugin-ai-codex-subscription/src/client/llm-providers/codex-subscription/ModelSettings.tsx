import React from 'react';
import { Collapse } from 'antd';
import { SchemaComponent } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';
import { namespace, useT } from '../../locale';

const Options: React.FC = () => {
  const t = useT();
  return (
    <Collapse
      bordered={false}
      size="small"
      items={[
        {
          key: 'options',
          label: t('Options'),
          forceRender: true,
          children: (
            <SchemaComponent
              schema={{
                type: 'void',
                properties: {
                  timeoutMs: {
                    title: tval('Timeout (ms)', { ns: namespace }),
                    type: 'number',
                    default: 180000,
                    'x-decorator': 'FormItem',
                    'x-component': 'InputNumber',
                  },
                  responseFormat: {
                    title: tval('Response format', { ns: namespace }),
                    type: 'string',
                    default: 'text',
                    'x-decorator': 'FormItem',
                    'x-component': 'Select',
                    enum: [
                      { label: t('Text'), value: 'text' },
                      { label: t('JSON'), value: 'json_object' },
                    ],
                  },
                },
              }}
            />
          ),
        },
      ]}
    />
  );
};

export const ModelSettingsForm: React.FC = () => {
  return (
    <SchemaComponent
      components={{ Options }}
      schema={{
        type: 'void',
        properties: {
          model: {
            title: tval('Model', { ns: namespace }),
            type: 'string',
            required: true,
            default: 'gpt-5.5',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          options: {
            type: 'void',
            'x-component': 'Options',
          },
        },
      }}
    />
  );
};
