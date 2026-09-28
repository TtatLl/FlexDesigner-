<template>
  <v-container class="lyric-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-text</v-icon>
        {{ $t('Lyric.Title') }}
      </v-card-title>

      <v-card-text>
        <v-list density="compact">
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showDualLine"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('Lyric.UI.ShowDualLine') }}</v-list-item-title>
          </v-list-item>

          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.showTranslation"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('Lyric.UI.ShowTranslation') }}</v-list-item-title>
          </v-list-item>

          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.highlightWord"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('Lyric.UI.HighlightWord') }}</v-list-item-title>
          </v-list-item>

          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data.useDynamicBackground"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t('Lyric.UI.UseDynamicBackground') }}</v-list-item-title>
          </v-list-item>
        </v-list>

        <v-divider class="my-3" />

        <v-row dense>
          <v-col cols="12">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.backgroundColor"
                  :label="$t('Lyric.UI.BackgroundColor')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.backgroundColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.backgroundColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
        </v-row>

        <v-divider class="my-3" />

        <div class="text-subtitle-2 mb-2">{{ $t('Lyric.UI.Primary.Title') }}</div>

        <v-row dense>
          <v-col cols="6">
            <v-select
              v-model="modelValue.data.primaryAlign"
              :items="alignOptions"
              :label="$t('Lyric.UI.Align')"
              variant="outlined"
              density="compact"
              hide-details
              @update:modelValue="emitUpdate"
            />
          </v-col>
          <v-col cols="6">
            <v-text-field
              v-model.number="modelValue.data.primaryFontSize"
              :label="$t('Lyric.UI.FontSize')"
              type="number"
              min="10"
              max="36"
              variant="outlined"
              density="compact"
              hide-details
              @update:modelValue="emitUpdate"
            />
          </v-col>
        </v-row>

        <v-row dense class="mt-2">
          <v-col cols="6">
            <v-text-field
              v-model.number="modelValue.data.singleLineFontSize"
              :label="$t('Lyric.UI.Primary.SingleLineFontSize')"
              type="number"
              min="10"
              max="42"
              variant="outlined"
              density="compact"
              hide-details
              @update:modelValue="emitUpdate"
            />
          </v-col>
          <v-col cols="6">
            <v-text-field
              v-model.number="modelValue.data.primaryPaddingTop"
              :label="$t('Lyric.UI.Primary.PaddingTop')"
              type="number"
              min="0"
              max="40"
              variant="outlined"
              density="compact"
              hide-details
              @update:modelValue="emitUpdate"
            />
          </v-col>
        </v-row>

        <v-row dense class="mt-2">
          <v-col cols="6">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.primaryColor"
                  :label="$t('Lyric.UI.Primary.Color')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.primaryColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.primaryColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
          <v-col cols="6">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.highlightColor"
                  :label="$t('Lyric.UI.Primary.HighlightColor')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.highlightColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.highlightColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
        </v-row>

        <template v-if="modelValue.data.showDualLine">
          <v-divider class="my-3" />
          <div class="text-subtitle-2 mb-2">{{ $t('Lyric.UI.Secondary.Title') }}</div>

          <v-row dense>
            <v-col cols="6">
              <v-select
                v-model="modelValue.data.secondaryAlign"
                :items="alignOptions"
                :label="$t('Lyric.UI.Align')"
                variant="outlined"
                density="compact"
                hide-details
                @update:modelValue="emitUpdate"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model.number="modelValue.data.secondaryFontSize"
                :label="$t('Lyric.UI.FontSize')"
                type="number"
                min="8"
                max="28"
                variant="outlined"
                density="compact"
                hide-details
                @update:modelValue="emitUpdate"
              />
            </v-col>
          </v-row>

          <v-row dense class="mt-2">
            <v-col cols="6">
              <v-menu :close-on-content-click="false">
                <template v-slot:activator="{ props }">
                  <v-text-field
                    v-model="modelValue.data.secondaryColor"
                    :label="$t('Lyric.UI.Secondary.Color')"
                    variant="outlined"
                    density="compact"
                    hide-details
                    readonly
                    v-bind="props"
                  >
                    <template v-slot:prepend-inner>
                      <div class="color-preview" :style="{ backgroundColor: modelValue.data.secondaryColor }" />
                    </template>
                  </v-text-field>
                </template>
                <v-color-picker
                  v-model="modelValue.data.secondaryColor"
                  mode="hex"
                  @update:modelValue="emitUpdate"
                />
              </v-menu>
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model.number="modelValue.data.secondaryPaddingTop"
                :label="$t('Lyric.UI.Secondary.PaddingTop')"
                type="number"
                min="0"
                max="50"
                variant="outlined"
                density="compact"
                hide-details
                @update:modelValue="emitUpdate"
              />
            </v-col>
          </v-row>
        </template>

        <v-divider class="my-3" />
        <div class="text-subtitle-2 mb-2">{{ $t('Lyric.UI.Padding.Title') }}</div>
        <v-row dense>
          <v-col cols="6">
            <v-text-field
              v-model.number="modelValue.data.paddingHorizontal"
              :label="$t('Lyric.UI.Padding.Horizontal')"
              type="number"
              min="0"
              max="40"
              variant="outlined"
              density="compact"
              hide-details
              @update:modelValue="emitUpdate"
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'LyricSettings',
  props: {
    modelValue: { type: Object, required: true }
  },
  emits: ['update:modelValue'],
  data() {
    return {
      alignOptions: [
        { title: this.$t('Lyric.UI.AlignLeft'), value: 'left' },
        { title: this.$t('Lyric.UI.AlignCenter'), value: 'center' },
        { title: this.$t('Lyric.UI.AlignRight'), value: 'right' }
      ]
    };
  },
  methods: {
    emitUpdate() {
      this.$emit('update:modelValue', this.modelValue);
    },
    initDefaults() {
      const d = this.modelValue.data || (this.modelValue.data = {});
      if (d.showDualLine === undefined) d.showDualLine = true;
      if (d.showTranslation === undefined) d.showTranslation = true;
      if (d.highlightWord === undefined) d.highlightWord = true;
      if (d.useDynamicBackground === undefined) d.useDynamicBackground = false;
      if (d.backgroundColor === undefined) d.backgroundColor = '#1A1A1A';
      if (d.primaryAlign === undefined) d.primaryAlign = 'center';
      if (d.primaryFontSize === undefined) d.primaryFontSize = 22;
      if (d.singleLineFontSize === undefined) d.singleLineFontSize = 28;
      if (d.primaryColor === undefined) d.primaryColor = '#FFFFFF';
      if (d.highlightColor === undefined) d.highlightColor = '#31C27C';
      if (d.primaryPaddingTop === undefined) d.primaryPaddingTop = 5;
      if (d.secondaryAlign === undefined) d.secondaryAlign = 'center';
      if (d.secondaryFontSize === undefined) d.secondaryFontSize = 17;
      if (d.secondaryColor === undefined) d.secondaryColor = '#D6D6D6';
      if (d.secondaryPaddingTop === undefined) d.secondaryPaddingTop = 35;
      if (d.paddingHorizontal === undefined) d.paddingHorizontal = 10;
    }
  },
  mounted() {
    this.initDefaults();
  }
};
</script>

<style scoped>
.lyric-settings {
  padding: 8px;
}

.color-preview {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid #666;
  cursor: pointer;
}
</style>
