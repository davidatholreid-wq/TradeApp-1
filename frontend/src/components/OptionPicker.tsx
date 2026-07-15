import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  TextInput,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "@/src/theme";

export type Option = { id: string; name: string };

type Props = {
  visible: boolean;
  title: string;
  options: Option[];
  onClose: () => void;
  onSelect: (opt: Option) => void;
  loading?: boolean;
  testID?: string;
};

export default function OptionPicker({ visible, title, options, onClose, onSelect, loading, testID }: Props) {
  const [query, setQuery] = useState("");
  const filtered = options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet} testID={testID}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} testID="picker-close-button" style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={colors.textSecondary} />
            <TextInput
              testID="picker-search-input"
              style={styles.searchInput}
              placeholder="Search..."
              placeholderTextColor={colors.textDisabled}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
            />
          </View>
          {loading ? (
            <Text style={styles.emptyText}>Loading...</Text>
          ) : filtered.length === 0 ? (
            <Text style={styles.emptyText}>No options</Text>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(i) => i.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  testID={`picker-option-${item.name}`}
                  style={styles.row}
                  onPress={() => {
                    onSelect(item);
                    setQuery("");
                  }}
                >
                  <Text style={styles.rowText}>{item.name}</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "80%",
    minHeight: "50%",
    paddingBottom: spacing.md,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  closeBtn: { padding: 4 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 15 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: { color: colors.text, fontSize: 15 },
  emptyText: { color: colors.textSecondary, textAlign: "center", padding: spacing.xl },
});
