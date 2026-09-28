<template>
  <v-container class="qqmusicnow-config">
    <v-card class="mx-auto" max-width="720">
      <v-card-title class="text-h6 d-flex align-center">
        <v-icon class="mr-2">mdi-music-note-eighth</v-icon>
        {{ $t('Config.Title') }}
      </v-card-title>

      <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ $t('Config.General.Title') }}</div>

        <v-select
          v-model="settings.provider"
          :items="providerOptions"
          :label="$t('Config.General.Provider')"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          v-model.number="settings.pollIntervalMs"
          :label="$t('Config.General.PollInterval')"
          type="number"
          min="500"
          max="5000"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          v-model="settings.manualSong"
          :label="$t('Config.General.ManualSong')"
          :hint="$t('Config.General.ManualSongHint')"
          persistent-hint
          variant="outlined"
          density="compact"
          class="mb-3"
        />

        <div class="text-subtitle-2 mt-2 mb-1">
          {{ $t('Config.General.Offset') }}
          <span class="offset-value">{{ settings.offsetMs }} ms</span>
        </div>
        <v-slider
          v-model="settings.offsetMs"
          :min="-3000"
          :max="3000"
          :step="50"
          thumb-label
          hide-details
          class="mb-1"
        />
        <div class="text-caption mb-3">{{ $t('Config.General.OffsetHint') }}</div>

        <v-text-field
          v-model="settings.fontFamily"
          :label="$t('Config.General.FontFamily')"
          :hint="$t('Config.General.FontFamilyHint')"
          persistent-hint
          variant="outlined"
          density="compact"
          class="mb-3"
        />

        <v-btn color="primary" variant="elevated" @click="save" prepend-icon="mdi-content-save">
          {{ $t('Config.Actions.Save') }}
        </v-btn>
      </v-card-text>

      <v-divider />

      <v-card-text>
        <div class="text-subtitle-2 mb-2">{{ $t('Config.Actions.Title') }}</div>

        <div class="d-flex flex-wrap ga-2 mb-3">
          <v-btn
            variant="tonal"
            :loading="probing"
            prepend-icon="mdi-magnify-scan"
            @click="probe"
          >
            {{ $t('Config.Actions.Probe') }}
          </v-btn>
          <v-btn variant="tonal" prepend-icon="mdi-refresh" @click="reloadLyrics">
            {{ $t('Config.Actions.Reload') }}
          </v-btn>
          <v-btn variant="tonal" prepend-icon="mdi-music-box" @click="openQqMusic">
            {{ $t('Config.Actions.OpenQqMusic') }}
          </v-btn>
        </div>

        <v-alert type="info" variant="tonal" density="compact" class="mb-2">
          <div>
            {{ $t('Config.Actions.CanvasAvailable') }}:
            {{ canvas.available ? $t('Config.Actions.Yes') : $t('Config.Actions.No') }}
            <span v-if="!canvas.available && canvas.error"> — {{ canvas.error }}</span>
          </div>
          <div v-if="!canvas.available" class="text-caption">
            {{ $t('Config.Actions.CanvasMissing') }}
          </div>
        </v-alert>

        <v-sheet border rounded class="pa-3 diagnostic">
          <div class="text-caption">{{ $t('Config.Actions.Result') }}</div>
          <pre class="diagnostic-json">{{ JSON.stringify(result, null, 2) }}</pre>
        </v-sheet>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'ConfigPage',
  data() {
    return {
      settings: {
        provider: 'auto',
        pollIntervalMs: 1000,
        offsetMs: 0,
        fontFamily: '',
        manualSong: ''
      },
      canvas: { available: null, error: null },
      probing: false,
      result: {}
    };
  },
  computed: {
    providerOptions() {
      return [
        { title: this.$t('Config.General.ProviderAuto'), value: 'auto' },
        { title: this.$t('Config.General.ProviderSmtc'), value: 'smtc' },
        { title: this.$t('Config.General.ProviderMacos'), value: 'macos' },
        { title: this.$t('Config.General.ProviderWindow'), value: 'window' },
        { title: this.$t('Config.General.ProviderManual'), value: 'manual' }
      ];
    }
  },
  methods: {
    async load(showErrors = true) {
      try {
        const response = await this.$fd.sendToBackend({ action: 'getConfig' });
        if (response && response.config) {
          this.settings = { ...this.settings, ...response.config };
        }
        if (response && response.canvas) this.canvas = response.canvas;
        this.result = { status: response?.status, lyrics: response?.lyrics, platform: response?.platform };
      } catch (error) {
        if (showErrors) this.$fd.error(`读取配置失败: ${error.message}`);
      }
    },
    async save() {
      try {
        await this.$fd.sendToBackend({
          action: 'saveConfig',
          data: {
            provider: this.settings.provider,
            pollIntervalMs: Number(this.settings.pollIntervalMs) || 1000,
            offsetMs: Number(this.settings.offsetMs) || 0,
            fontFamily: this.settings.fontFamily,
            manualSong: this.settings.manualSong
          }
        });
        this.$fd.info(this.$t('Config.Actions.Saved'));
        await this.load(false);
      } catch (error) {
        this.$fd.error(`保存失败: ${error.message}`);
      }
    },
    async probe() {
      this.probing = true;
      try {
        this.result = await this.$fd.sendToBackend({ action: 'probe' });
        if (!this.result.ok) this.$fd.warn(this.$t('Config.Actions.NoResult'));
      } catch (error) {
        this.$fd.error(`测试失败: ${error.message}`);
      } finally {
        this.probing = false;
      }
    },
    async reloadLyrics() {
      try {
        const response = await this.$fd.sendToBackend({ action: 'reloadLyrics' });
        this.result = { ...this.result, reload: response };
      } catch (error) {
        this.$fd.error(`重新加载失败: ${error.message}`);
      }
    },
    async openQqMusic() {
      try {
        await this.$fd.sendToBackend({ action: 'openQqMusic' });
      } catch (error) {
        this.$fd.error(`打开 QQ 音乐失败: ${error.message}`);
      }
    }
  },
  mounted() {
    this.load();
  }
};
</script>

<style scoped>
.qqmusicnow-config {
  padding: 8px;
}

.offset-value {
  font-weight: 600;
  margin-left: 6px;
}

.diagnostic {
  max-height: 260px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.04);
}

.diagnostic-json {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
