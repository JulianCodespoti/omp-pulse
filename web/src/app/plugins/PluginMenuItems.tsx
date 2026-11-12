import type { JSX } from "react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

import type { PluginNode } from "../../domain/plugins";
import type { PluginSlotView } from "../../runtime/plugin-host";
import { Row, RowGroup } from "../ui/Row";

interface MenuItem {
  id: string | undefined;
  label: string;
  detail: string | undefined;
  danger: boolean;
}

interface MenuList {
  pluginId: string;
  pluginName: string;
  action: string;
  items: MenuItem[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A plugin's `list` view as menu rows; anything else, or a list nobody can tap, draws nothing. */
function toMenuList(entry: PluginSlotView): MenuList | null {
  const node: PluginNode = entry.view;
  if (node.k !== "list") return null;
  const actions = node.p.actions;
  const action = typeof actions === "object" && actions !== null ? text((actions as Record<string, unknown>).click) : undefined;
  if (!action || !Array.isArray(node.p.items)) return null;
  const items: MenuItem[] = [];
  for (const raw of node.p.items) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    items.push({ id: text(item.id), label: text(item.label) ?? "", detail: text(item.detail), danger: item.tone === "error" });
  }
  return items.length ? { pluginId: entry.pluginId, pluginName: entry.pluginName, action, items } : null;
}

/**
 * Plugin menu rows for `session.menu` and `composer.actions`, grouped under the
 * plugin's name. The sheet variant matches the actions bottom sheet, the
 * dropdown variant the menus (chat header, composer plus). It retains nothing:
 * the host surface owns the slot and passes its views in. A tap dispatches the
 * list's action with the item's id, then closes the host surface.
 */
export function PluginMenuItems({
  variant,
  views,
  onAction,
  onClose,
}: {
  variant: "sheet" | "dropdown";
  views: PluginSlotView[];
  onAction: (pluginId: string, action: string, item?: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const lists = views.flatMap((entry) => {
    const list = toMenuList(entry);
    return list ? [list] : [];
  });
  if (lists.length === 0) return null;
  const choose = (list: MenuList, item: MenuItem): void => {
    onAction(list.pluginId, list.action, item.id);
    onClose();
  };
  if (variant === "sheet") {
    return (
      <>
        {lists.map((list) => (
          <RowGroup key={list.pluginId} title={list.pluginName}>
            {list.items.map((item, index) => (
              <Row
                key={index}
                testId="plugin-menu-item"
                data-plugin={list.pluginId}
                data-item={item.id}
                destructive={item.danger}
                title={item.label}
                subtitle={item.detail}
                onClick={() => choose(list, item)}
              />
            ))}
          </RowGroup>
        ))}
      </>
    );
  }
  return (
    <>
      {lists.map((list) => (
        <div key={list.pluginId}>
          <DropdownMenuSeparator className="my-1.5" />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{list.pluginName}</DropdownMenuLabel>
            {list.items.map((item, index) => (
              <DropdownMenuItem
                key={index}
                data-testid="plugin-menu-item"
                data-plugin={list.pluginId}
                data-item={item.id}
                variant={item.danger ? "danger" : "default"}
                onClick={() => choose(list, item)}
              >
                <span className="flex min-w-0 flex-1 flex-col py-1.5">
                  <span className="truncate">{item.label}</span>
                  {item.detail ? <span className="truncate text-meta text-muted-foreground">{item.detail}</span> : null}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </div>
      ))}
    </>
  );
}
