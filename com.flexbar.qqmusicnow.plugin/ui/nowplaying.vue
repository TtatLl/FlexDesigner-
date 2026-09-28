<template>
  <v-container class="nowplaying-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-music</v-icon>
        {{ $t('NowPlaying.Title') }}
      </v-card-title>

      <v-card-text>
        <v-list density="compact">
          <v-list-item v-for="item in toggles" :key="item.key">
            <template v-slot:prepend>
              <v-checkbox
                v-model="modelValue.data[item.key]"
                hide-details
                density="compact"
                @update:modelValue="emitUpdate"
              />
            </template>
            <v-list-item-title>{{ $t(item.label) }}</v-list-item-title>
          </v-list-item>
        </v-list>

        <v-divider class="my-3" />

        <v-row dense>
          <v-col cols="12">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.backgroundColor"
                  :label="$t('NowPlaying.UI.BackgroundColor')"
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

        <v-row dense class="mt-2">
          <v-col cols="6">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.primaryTextColor"
                  :label="$t('NowPlaying.UI.PrimaryTextColor')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.primaryTextColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.primaryTextColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
          <v-col cols="6">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.secondaryTextColor"
                  :label="$t('NowPlaying.UI.SecondaryTextColor')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.secondaryTextColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.secondaryTextColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
        </v-row>

        <v-divider class="my-3" />
        <div class="text-subtitle-2 mb-2">{{ $t('NowPlaying.UI.Progress.Title') }}</div>
        <v-row dense>
          <v-col cols="6">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.progressFillColor"
                  :label="$t('NowPlaying.UI.Progress.FillColor')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.progressFillColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.progressFillColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
          <v-col cols="6">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-text-field
                  v-model="modelValue.data.progressBgColor"
                  :label="$t('NowPlaying.UI.Progress.BgColor')"
                  variant="outlined"
                  density="compact"
                  hide-details
                  readonly
                  v-bind="props"
                >
                  <template v-slot:prepend-inner>
                    <div class="color-preview" :style="{ backgroundColor: modelValue.data.progressBgColor }" />
                  </template>
                </v-text-field>
              </template>
              <v-color-picker
                v-model="modelValue.data.progressBgColor"
                mode="hex"
                @update:modelValue="emitUpdate"
              />
            </v-menu>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'NowPlayingSettings',
  props: {
    modelValue: { type: Object, required: true }
  },
  emits: ['update:modelValue'],
  data() {
    return {
      toggles: [
        { key: 'showCover', label: 'NowPlaying.UI.ShowCover' },
        { key: 'showTitle', label: 'NowPlaying.UI.ShowTitle' },
        { key: 'showArtist', label: 'NowPlaying.UI.ShowArtist' },
        { key: 'showAlbum', label: 'NowPlaying.UI.ShowAlbum' },
        { key: 'showProgress', label: 'NowPlaying.UI.ShowProgress' },
        { key: 'showTime', label: 'NowPlaying.UI.ShowTime' },
        { key: 'useDynamicBackground', label: 'NowPlaying.UI.UseDynamicBackground' }
      ]
    };
  },
  methods: {
    emitUpdate() {
      this.$emit('update:modelValue', this.modelValue);
    }
  },
  mounted() {
    const d = this.modelValue.data || (this.modelValue.data = {});
    if (d.showCover === undefined) d.showCover = true;
    if (d.showTitle === undefined) d.showTitle = true;
    if (d.showArtist === undefined) d.showArtist = true;
    if (d.showAlbum === undefined) d.showAlbum = true;
    if (d.showProgress === undefined) d.showProgress = true;
    if (d.showTime === undefined) d.showTime = true;
    if (d.useDynamicBackground === undefined) d.useDynamicBackground = true;
  }
};
</script>

<style scoped>
.nowplaying-settings {
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
