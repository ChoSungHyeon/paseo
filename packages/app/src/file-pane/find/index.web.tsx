import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import { Search } from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import { usePaneFocus } from "@/panels/pane-context";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { FileFindModel } from "./model.web";

export { FileFindModel } from "./model.web";

const SearchIcon = withUnistyles(Search, mutedIconColorMapping);

export function FileFind({
  model,
  editor,
}: {
  model: FileFindModel;
  editor: RefObject<EditorView | null>;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const isCompact = useIsCompactFormFactor();
  const widget = useRef<PaneFindHandle>(null);
  const { isInteractive, focusPane } = usePaneFocus();
  const active = useRetainedPanelActive();
  const open = useCallback(() => {
    focusPane();
    model.open(editor.current);
    widget.current?.focus();
  }, [editor, focusPane, model]);

  useEffect(() => {
    if (!isInteractive || !active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        model.open(editor.current);
        widget.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, editor, isInteractive, model]);

  const replace = useMemo(
    () =>
      state.readOnly
        ? undefined
        : {
            value: state.replacement,
            onChange: model.setReplacement,
            onReplace: model.replace,
            onReplaceAll: model.replaceAll,
          },
    [model, state.readOnly, state.replacement],
  );
  if (!state.panel)
    return (
      <View style={styles.trigger}>
        <ToolbarButton label={t("paneFind.title")} compact={isCompact} onPress={open}>
          <SearchIcon size={paneContentToolbarIconSize(isCompact)} />
        </ToolbarButton>
      </View>
    );
  const total = `${state.total}${state.limited ? "+" : ""}`;
  let status = "";
  if (state.query) {
    if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current) status = t("paneFind.position", { current: state.current, total });
    else status = t("paneFind.total", { total });
  }
  return createPortal(
    <View style={styles.panel}>
      <PaneFind
        ref={widget}
        query={state.query}
        status={status}
        canNavigate={state.total > 0}
        onQueryChange={model.setSearch}
        onNext={model.next}
        onPrevious={model.previous}
        onClose={model.close}
        replace={replace}
      />
    </View>,
    state.panel,
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { alignItems: "flex-end", maxWidth: "100%", padding: theme.spacing[2] },
  // Carries the open widget's chrome so the entry point reads as the same object.
  trigger: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 1,
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.md,
  },
}));
