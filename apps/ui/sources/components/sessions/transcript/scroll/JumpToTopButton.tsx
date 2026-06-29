import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';

export const JumpToTopButton = React.memo(function JumpToTopButton(props: {
    onPress: () => void;
    testID?: string;
}) {
    const { theme } = useUnistyles();
    return (
        <GlassPanel shadowLevel={2} innerShadow={false}>
            <Pressable
                testID={props.testID}
                onPress={props.onPress}
                accessibilityRole="button"
                accessibilityLabel="Jump to top"
                style={({ pressed }) => [styles.button, pressed && { opacity: 0.92 }]}
            >
                <Ionicons name="chevron-up" size={16} color={theme.colors.text.primary} />
            </Pressable>
        </GlassPanel>
    );
});

const styles = StyleSheet.create(() => ({
    button: {
        alignItems: 'center',
        height: 40,
        justifyContent: 'center',
        minWidth: 40,
        paddingHorizontal: 8,
    },
}));
