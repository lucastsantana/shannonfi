#!/usr/bin/env python3
"""
Generate charts for the Shannon's Demon strategy deck.
Outputs three PNG files to data/reports/charts/:
  chart_performance.png   — cumulative performance base 100, log Y
  chart_drawdown.png      — rolling drawdown from peak
  chart_monthly_heatmap.png — Shannon monthly returns calendar
"""

import os
import sys
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT  = os.path.dirname(SCRIPT_DIR)
CSV_PATH   = os.path.join(SCRIPT_DIR, 'inception_timeseries.csv')
CHARTS_DIR = os.path.join(REPO_ROOT, 'data', 'reports', 'charts')

os.makedirs(CHARTS_DIR, exist_ok=True)

# ── Colorblind palette (Okabe-Ito derived, matching Beamer theme) ──────────────
C_SHANNON = '#0A2540'   # Navy — Shannon's Demon
C_BH      = '#009E73'   # OI Green — 50/50 Buy-and-Hold
C_SOL     = '#D55E00'   # OI Vermillion — 100% SOL
C_CDI     = '#C49A19'   # Gold — CDI
C_IBOV    = '#56B4E9'   # OI Sky Blue — IBOV

DANGER    = '#DC2626'   # red
SUCCESS   = '#059669'   # green
BODY_TEXT = '#0A2540'
RULE_COLOR = '#CBD5E1'
MUTED_TEXT = '#6B7280'

# ── Load data ──────────────────────────────────────────────────────────────────
if not os.path.exists(CSV_PATH):
    print(f'ERROR: {CSV_PATH} not found', file=sys.stderr)
    sys.exit(1)

df = pd.read_csv(CSV_PATH, parse_dates=['date'])
df = df.sort_values('date').reset_index(drop=True)

print(f'Loaded {len(df)} rows  ({df["date"].iloc[0].date()} → {df["date"].iloc[-1].date()})')

# ─────────────────────────────────────────────────────────────────────────────
# Shared axis styling helper
# ─────────────────────────────────────────────────────────────────────────────
def style_ax(ax):
    ax.tick_params(colors=BODY_TEXT, labelsize=8)
    for spine in ax.spines.values():
        spine.set_color(RULE_COLOR)
    ax.grid(True, which='major', color=RULE_COLOR, lw=0.5, alpha=0.7)
    ax.set_xlabel('Date', color=BODY_TEXT, fontsize=9)

def make_legend(ax, **kwargs):
    leg = ax.legend(fontsize=8, framealpha=0.95, edgecolor=RULE_COLOR, **kwargs)
    leg.get_frame().set_facecolor('white')
    return leg

# ─────────────────────────────────────────────────────────────────────────────
# Chart 1 — Cumulative Performance (base 100, log scale)
# ─────────────────────────────────────────────────────────────────────────────
fig1, ax1 = plt.subplots(figsize=(12, 4.8), facecolor='none')
ax1.set_facecolor('none')

ax1.semilogy(df['date'], df['shannon_nolimit'], color=C_SHANNON, lw=2.0,
             label="Shannon's Demon", zorder=5)
ax1.semilogy(df['date'], df['buyhold'],          color=C_BH,      lw=1.4,
             label='50/50 Buy-and-Hold', ls='--')
ax1.semilogy(df['date'], df['sol_only'],         color=C_SOL,     lw=1.4,
             label='100% SOL', ls=':')
ax1.semilogy(df['date'], df['cdi'],              color=C_CDI,     lw=1.2,
             label='CDI', ls='-.')
ax1.semilogy(df['date'], df['ibov'],             color=C_IBOV,    lw=1.2,
             label='IBOV', ls='-.')

style_ax(ax1)
ax1.set_ylabel('Portfolio Value (Base 100, log scale)', color=BODY_TEXT, fontsize=9)
ax1.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
ax1.yaxis.set_minor_formatter(mticker.NullFormatter())
ax1.grid(True, which='minor', color=RULE_COLOR, lw=0.3, alpha=0.3)
make_legend(ax1, loc='upper left')

fig1.tight_layout(pad=0.5)
out1 = os.path.join(CHARTS_DIR, 'chart_performance.png')
fig1.savefig(out1, dpi=200, bbox_inches='tight', transparent=True)
plt.close(fig1)
print(f'Saved  {os.path.relpath(out1, REPO_ROOT)}')

# ─────────────────────────────────────────────────────────────────────────────
# Chart 2 — Rolling Drawdown from Peak
# ─────────────────────────────────────────────────────────────────────────────
def rolling_dd(series):
    peak = series.cummax()
    return (series - peak) / peak * 100.0

dd_shannon = rolling_dd(df['shannon_nolimit'])
dd_bh      = rolling_dd(df['buyhold'])
dd_sol     = rolling_dd(df['sol_only'])
dd_ibov    = rolling_dd(df['ibov'])

fig2, ax2 = plt.subplots(figsize=(12, 4.8), facecolor='none')
ax2.set_facecolor('none')

ax2.fill_between(df['date'], dd_shannon, 0, color=C_SHANNON, alpha=0.20, zorder=3)
ax2.plot(df['date'], dd_shannon, color=C_SHANNON, lw=2.0, label="Shannon's Demon", zorder=4)
ax2.plot(df['date'], dd_bh,      color=C_BH,      lw=1.4, label='50/50 Buy-and-Hold', ls='--')
ax2.plot(df['date'], dd_sol,     color=C_SOL,     lw=1.4, label='100% SOL', ls=':')
ax2.plot(df['date'], dd_ibov,    color=C_IBOV,    lw=1.2, label='IBOV', ls='-.')

ax2.axhline(0, color=RULE_COLOR, lw=0.6)
style_ax(ax2)
ax2.set_ylabel('Drawdown from Peak (%)', color=BODY_TEXT, fontsize=9)
ax2.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:.0f}%'))
make_legend(ax2, loc='lower left')

fig2.tight_layout(pad=0.5)
out2 = os.path.join(CHARTS_DIR, 'chart_drawdown.png')
fig2.savefig(out2, dpi=200, bbox_inches='tight', transparent=True)
plt.close(fig2)
print(f'Saved  {os.path.relpath(out2, REPO_ROOT)}')

# ─────────────────────────────────────────────────────────────────────────────
# Chart 3 — Shannon Monthly Return Heatmap
# ─────────────────────────────────────────────────────────────────────────────
# Compute end-of-month series, then monthly returns
eom = df.set_index('date')['shannon_nolimit'].resample('ME').last()
monthly_ret = eom.pct_change() * 100.0
# First data point is 2020-04-10; April return = (eom_april / 100 − 1) × 100
monthly_ret.iloc[0] = (eom.iloc[0] / 100.0 - 1.0) * 100.0

# Build year × month grid
years = sorted(monthly_ret.index.year.unique())
month_labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

matrix = np.full((len(years), 12), np.nan)
for dt, val in monthly_ret.items():
    yi = years.index(dt.year)
    mi = dt.month - 1
    matrix[yi, mi] = val

# Diverging red → white → green colormap, clipped at ±35%
cmap_rwg = LinearSegmentedColormap.from_list(
    'rdwgn',
    [(0.0, DANGER), (0.5, '#FFFFFF'), (1.0, SUCCESS)],
    N=256
)
norm = TwoSlopeNorm(vmin=-35, vcenter=0, vmax=35)

fig3_h = max(2.2, len(years) * 0.55)
fig3, ax3 = plt.subplots(figsize=(14, fig3_h), facecolor='none')
ax3.set_facecolor('none')

im = ax3.imshow(matrix, cmap=cmap_rwg, norm=norm, aspect='auto')

ax3.set_xticks(range(12))
ax3.set_xticklabels(month_labels, fontsize=8, color=BODY_TEXT)
ax3.set_yticks(range(len(years)))
ax3.set_yticklabels([str(y) for y in years], fontsize=8, color=BODY_TEXT)
ax3.tick_params(length=0, colors=BODY_TEXT)
for spine in ax3.spines.values():
    spine.set_visible(False)

# Cell annotations
for yi in range(len(years)):
    for mi in range(12):
        val = matrix[yi, mi]
        if not np.isnan(val):
            sign = '+' if val >= 0 else ''
            text_color = 'white' if abs(val) > 18 else BODY_TEXT
            ax3.text(mi, yi, f'{sign}{val:.1f}%',
                     ha='center', va='center',
                     fontsize=6.2, color=text_color, fontweight='bold')

cbar = plt.colorbar(im, ax=ax3, orientation='vertical', pad=0.01, fraction=0.025)
cbar.ax.tick_params(labelsize=7, colors=BODY_TEXT)
cbar.ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:+.0f}%'))

fig3.tight_layout(pad=0.3)
out3 = os.path.join(CHARTS_DIR, 'chart_monthly_heatmap.png')
fig3.savefig(out3, dpi=200, bbox_inches='tight', transparent=True)
plt.close(fig3)
print(f'Saved  {os.path.relpath(out3, REPO_ROOT)}')

print('\nAll charts generated successfully.')
