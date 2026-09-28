<template>
  <v-container class="source-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-information-outline</v-icon>
        {{ $t('Source.Title') }}
      </v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-3">{{ $t('Source.Tip') }}</p>
        <v-list density="compact">
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showProviderName"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('Source.UI.ShowProviderName') }}</v-list-item-title>
          </v-list-item>
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showLyricSource"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('Source.UI.ShowLyricSource') }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'SourceSettings',
  props: {
    modelValue: { type: Object, required: true }
  },
  emits: ['update:modelValue'],
  methods: {
    emitUpdate() {
      this.$emit('update:modelValue', this.modelValue);
    }
  },
  mounted() {
    const d = this.modelValue.data || (this.modelValue.data = {});
    if (d.showProviderName === undefined) d.showProviderName = true;
    if (d.showLyricSource === undefined) d.showLyricSource = true;
  }
};
</script>

<style scoped>
.source-settings {
  padding: 8px;
}
</style>
