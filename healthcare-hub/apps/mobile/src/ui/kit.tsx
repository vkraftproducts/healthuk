import type { ReactNode } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, TOUCH } from './theme';

export type Tone = 'GREEN' | 'AMBER' | 'RED' | 'GREY';
const TONE: Record<Tone, { fg: string; bg: string; icon: string }> = {
  GREEN: { fg: colors.green, bg: colors.greenBg, icon: '✓' },
  AMBER: { fg: colors.amber, bg: colors.amberBg, icon: '!' },
  RED: { fg: colors.red, bg: colors.redBg, icon: '✕' },
  GREY: { fg: colors.grey, bg: colors.greyBg, icon: '–' },
};

/** Maps any status word used by the API to a tone. Unknown words are grey, never green. */
export function toneOf(status: string): Tone {
  if (
    ['APPROVED', 'COMPLETE', 'GREEN', 'PASS', 'AVAILABLE', 'VERIFIED', 'CURRENT'].includes(status)
  )
    return 'GREEN';
  if (
    ['REQUIRED', 'AMBER', 'PENDING', 'DUE_SOON', 'PENDING_VERIFICATION', 'RESTRICTED'].includes(
      status,
    )
  )
    return 'AMBER';
  if (
    ['BLOCKED', 'RED', 'FAIL', 'OFF_ROAD', 'EXPIRED', 'OVERDUE', 'REJECTED', 'CONFLICT'].includes(
      status,
    )
  )
    return 'RED';
  return 'GREY';
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const t = TONE[toneOf(status)];
  const text = label ?? words(status);
  return (
    <View
      style={[s.pill, { backgroundColor: t.bg, borderColor: t.fg }]}
      accessible
      accessibilityLabel={`Status: ${text}`}
    >
      <Text style={[s.pillText, { color: t.fg }]}>
        {t.icon} {text}
      </Text>
    </View>
  );
}

export const words = (code: string) =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

export function Screen({
  title,
  children,
  onBack,
  onRefresh,
  refreshing,
}: {
  title: string;
  children: ReactNode;
  onBack?: () => void;
  /** Pull to refresh (fetches from the server when online). */
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <View style={s.screen}>
      <View style={s.header}>
        {onBack && (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={s.back}
          >
            <Text style={s.backText}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={s.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        {...(onRefresh
          ? {
              refreshControl: (
                <RefreshControl
                  refreshing={!!refreshing}
                  onRefresh={onRefresh}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                  progressBackgroundColor={colors.card}
                />
              ),
            }
          : {})}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function Card({
  title,
  children,
  right,
}: {
  title?: string;
  children?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={s.card}>
      {(title || right) && (
        <View style={s.cardHead}>
          {title ? (
            <Text style={s.cardTitle} accessibilityRole="header">
              {title}
            </Text>
          ) : (
            <View />
          )}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  kind = 'primary',
  hint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'danger';
  hint?: string;
}) {
  const bg =
    kind === 'primary' ? colors.primary : kind === 'danger' ? colors.dangerSolid : colors.card;
  const fg =
    kind === 'danger'
      ? colors.onDanger
      : kind === 'secondary'
        ? colors.primary
        : colors.primaryText;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      {...(hint ? { accessibilityHint: hint } : {})}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? colors.primary : bg },
        kind === 'primary' && !disabled && s.glow,
        disabled && s.disabled,
        pressed && !disabled && s.pressed,
      ]}
    >
      <Text style={[s.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <View
      style={[s.banner, { backgroundColor: t.bg, borderColor: t.fg }]}
      accessibilityRole="alert"
    >
      <Text style={[s.bannerText, { color: t.fg }]}>
        {t.icon} {children}
      </Text>
    </View>
  );
}

export function PendingBadge({ label = 'Pending sync' }: { label?: string }) {
  return (
    <View style={[s.pill, { backgroundColor: colors.amberBg, borderColor: colors.amber }]}>
      <Text style={[s.pillText, { color: colors.amber }]}>⟳ {label}</Text>
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  multiline,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
  multiline?: boolean;
  error?: string | null;
  placeholder?: string;
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        keyboardType={keyboardType ?? 'default'}
        multiline={!!multiline}
        style={[
          s.input,
          multiline && { minHeight: 96 },
          error ? { borderColor: colors.red } : null,
        ]}
        placeholderTextColor={colors.muted}
        selectionColor={colors.primary}
        {...(placeholder ? { placeholder } : {})}
      />
      {error ? (
        <Text style={s.error} accessibilityRole="alert">
          ✕ {error}
        </Text>
      ) : null}
    </View>
  );
}

/** Mutually exclusive choice as large buttons (radio group). */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={s.label}>{label}</Text>
      <View style={s.row}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${o.label}`}
              accessibilityState={{ checked: on }}
              style={[s.choice, on && s.choiceOn]}
            >
              <Text style={[s.choiceText, on && { color: colors.primaryText }]}>
                {on ? '● ' : '○ '}
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={[s.field, s.toggle]}>
      <Text style={[s.label, { flex: 1 }]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={value ? colors.primaryText : colors.muted}
      />
    </View>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={s.kvValue}>{value}</Text> : value}
    </View>
  );
}

export const P = ({ children, muted }: { children: ReactNode; muted?: boolean }) => (
  <Text style={[s.p, muted && { color: colors.muted }]}>{children}</Text>
);

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: colors.primary, fontSize: 17, fontWeight: '600' },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  body: { padding: 16, gap: 12, paddingBottom: 48 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
    shadowColor: '#1f3a52',
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.text, flexShrink: 1 },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  pillText: { fontWeight: '700', fontSize: 14 },
  glow: {
    shadowColor: colors.glow,
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  button: {
    minHeight: TOUCH,
    borderRadius: 14,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 18, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  banner: { borderWidth: 2, borderRadius: 14, padding: 12 },
  bannerText: { fontSize: 16, fontWeight: '700' },
  field: { gap: 6 },
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  input: {
    minHeight: TOUCH,
    borderWidth: 1,
    borderColor: colors.edge,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 17,
    backgroundColor: colors.field,
    color: colors.text,
  },
  error: { color: colors.red, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    minHeight: TOUCH,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.primary,
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  choiceOn: { backgroundColor: colors.primary },
  choiceText: { fontSize: 16, fontWeight: '600', color: colors.primary },
  toggle: { flexDirection: 'row', alignItems: 'center', minHeight: TOUCH },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  kvLabel: { color: colors.muted, fontSize: 15 },
  kvValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  p: { fontSize: 16, color: colors.text, lineHeight: 22 },
});
