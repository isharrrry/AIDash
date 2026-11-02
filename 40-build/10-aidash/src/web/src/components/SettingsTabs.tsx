import { useRef } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

export interface SettingsTabItem<T extends string = string> {
  id: T;
  label: string;
  /** 可选的数量角标，例如 Harness 注册数量；未提供时不渲染。 */
  badge?: string;
}

interface SettingsTabsProps<T extends string> {
  tabs: ReadonlyArray<SettingsTabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  children: ReactNode;
}

const TAB_ID_PREFIX = 'settings-tab';

function tabId(id: string): string {
  return `${TAB_ID_PREFIX}-${id}`;
}

function panelId(id: string): string {
  return `${TAB_ID_PREFIX}panel-${id}`;
}

/**
 * 设置页的页内分区。
 *
 * 未激活分区只保留空的 tabpanel 外壳：提示词、LLM 表单和审计查询的挂载成本
 * 都不低，不该随设置页一起初始化。空壳保证每个 tab 的 aria-controls 始终有
 * 对应节点，同时 content 只在选中时渲染。
 */
export function SettingsTabs<T extends string>({
  tabs,
  active,
  onChange,
  children,
}: SettingsTabsProps<T>): ReactElement {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number): void => {
    const tab = tabs[index];
    if (!tab) return;
    onChange(tab.id);
    // 选中态和 tabIndex 要等同键盘焦点一起迁移，读屏用户才知道当前分区。
    tabRefs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusTab(next);
  };

  return (
    <>
      <div className="settings-tabs" role="tablist" aria-label="设置分区">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              className="settings-tab"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
              {tab.badge !== undefined ? (
                <span className="settings-tab-count">{tab.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            id={panelId(tab.id)}
            role="tabpanel"
            aria-labelledby={tabId(tab.id)}
            hidden={!selected}
            tabIndex={selected ? 0 : -1}
            className="settings-tabpanel"
          >
            {selected ? children : null}
          </div>
        );
      })}
    </>
  );
}
