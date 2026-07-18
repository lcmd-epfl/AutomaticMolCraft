# Model Training

The **Model training** tab exposes the full MolCraftDiffusion training pipeline from the browser.

!!! note "Extended task families"
    Some task families are hidden by default. If the server sets `MOLCRAFT_UNLOCK_PASSWORD` (see [Installation](installation.md)), an unlock field appears above the form — enter the password and click **Unlock** to reveal the extended families ("Extended models unlocked" is shown on success). The public families work without unlocking.

## Layout

| Column | Contents |
|---|---|
| **Left** (fixed 440 px) | Presets bar, YAML import, experiment metadata, collapsible parameter form |
| **Right** (remaining width) | Job history list |

---

## YAML import

Rather than filling the form manually, you can import an existing training YAML:

**From a file path** — paste an absolute path into the text box and press **Enter** or click the arrow button. The backend reads the file and populates every form field.

**From a file upload** — click the upload button and select a `.yaml` or `.yml` file.

Both methods overwrite the current form state entirely. After import you can still edit individual fields before submitting.

---

## Task family

The **Task family** dropdown selects the learning objective. It controls which form sections appear below.

| Family | Category | Description |
|---|---|---|
| `diffusion` | diffusion | DDPM-based 3D molecule generation (the default generative model) |
| `flow_matching` | flow_matching | Flow-matching variant of the generative model |
| `regression` | regression | Supervised property predictor (used by CFG models for property steering) |
| `ssl3d` | ssl3d | Self-supervised 3D pre-training (denoising + masking) |
| `vae` | vae | Variational autoencoder for latent-space generation |

---

## Run mode

| Mode | Submit button | Effect |
|---|---|---|
| **Run** | **Queue training job** | Queues a real training job; the backend launches the training process and streams logs |
| **Dry** | **Generate YAML** | Generates and validates the YAML configuration only — no training runs. The YAML is shown inline with a **Copy command** button and a **Download YAML** button |

Use **Dry** to inspect or share the configuration before committing compute.

---

## Form sections

Sections are collapsible (click the section title to toggle). Which sections appear depends on the task family.

| Section | Shown for |
|---|---|
| Data | all |
| Model | all |
| Diffusion settings | diffusion, flow_matching |
| Regression settings | regression |
| SSL-3D settings | ssl3d |
| VAE settings | vae |
| Trainer | all |
| Logger | all |
| Engine | all |

---

### Experiment metadata

| Field | Default | Description |
|---|---|---|
| Experiment name | *(required)* | Label used for the output directory and logger run name |
| Seed | 42 | Global random seed for reproducibility |

---

### Data

| Parameter | Default | Description |
|---|---|---|
| Dataset path | *(required)* | Absolute path to the training dataset (CSV + XYZ folder or ASE `.db`) |
| Batch size | 48 | Molecules per training step |
| Max atom count | 86 | Molecules with more atoms than this are excluded |
| Atom vocabulary | `H, B, C, N, O, F, Al, Si, P, S, Cl, As, Se, Br, I` | Comma-separated element symbols. Molecules containing unlisted elements are excluded unless **Allow unknown** is on |
| Train ratio | 0.8 | Fraction used for training; the remainder becomes the validation set |
| With hydrogen | true | Include hydrogen atoms in the geometry |
| Use OHE feature | true | One-hot encode atom type as a feature vector |
| Allow unknown | false | Pass through molecules with elements outside the vocabulary (marked with a special unknown token) |
| Data-efficient collator | true | Use a variable-length batching strategy that reduces padding; improves GPU utilisation on diverse atom-count datasets |

---

### Model

| Parameter | Default | Description |
|---|---|---|
| Hidden size | 256 | Embedding dimension for all attention layers |
| Number of layers | 9 | Transformer depth |
| Number of sub-layers | 1 | Sub-layers per transformer block |
| Dropout | 0 | Dropout probability (0 = disabled) |
| Attention | true | Enable multi-head self-attention; set to false for a simpler MLP baseline |
| Tanh | true | Apply tanh activation in the output head to bound predicted noise |

---

### Diffusion settings

Applies to **diffusion** and **flow_matching** task families.

| Parameter | Default | Description |
|---|---|---|
| Diffusion steps | 500 | Total forward-process steps T |
| Noise schedule | `polynomial_2` | Variance schedule shape: `linear`, `cosine`, `polynomial_2` |
| Loss type | `vlb` | Training objective: `vlb` (variational lower bound) or `l2` |
| Context mask rate | 0 | Fraction of property context randomly masked during training — enables CFG at inference. Set > 0 to train a conditional model |
| Normalize factors | `1.0, 4.0, 10.0` | Per-channel scaling applied to atom coordinates, atom types, and charges before diffusion |
| n_samples | 48 | Molecules generated per validation generative analysis run |
| Generative analysis | true | Run a sample-quality evaluation at each validation step |
| Use PoseBuster | true | Include PoseBuster validity metrics in the generative analysis |

#### Conditional training (CFG)

Setting **Context mask rate** > 0 trains a conditional model compatible with classifier-free guidance (CFG) at inference. During each training step, the property label is randomly dropped with this probability; the model learns both the conditional (`φ(z, t, y)`) and unconditional (`φ(z, t)`) denoising distributions in one pass. At inference, the two predictions are combined as:

```
ε̃ = (1 + w) φ(z, t, y) − w φ(z, t)
```

where `w` is the CFG scale set at generation time. Typical values for Context mask rate are 0.1–0.3.

**Property normalization** affects how strongly the conditioning signal contributes to the denoising function and consequently how well CFG guidance transfers to generated structures. Two common approaches:

- **Fixed scaling** — multiply the raw property value by a constant before feeding it to the model. Simple but sensitive to the chosen scale.
- **MAD normalization** — scale property values by the median absolute deviation of the training set. More robust across different property ranges and has been shown to retain a higher structural validity rate at strong CFG scales compared to fixed scaling.

Choose the normalization scheme consistently across the generative and regression (property-predictor) models for a given experiment.

**Conditioning mechanism** — MolCraftDiffusion supports two ways to inject the property signal into the denoising network:

| Mechanism | How it works | Notes |
|---|---|---|
| **Feature concatenation (Concat.)** | The property label `y` is appended directly to the molecular representation before each denoising step: `z = [x, h, y]`. | The conditional variable becomes part of the main noise-prediction input, giving it a stronger gradient during fine-tuning. Generally effective for CFG-guided generation. |
| **Adapter** | A learnable MLP maps `y` into the hidden feature space of each EGNN block and adds this contribution only when the property context is present. | Attaches the conditioning pathway to an already-trained denoising network; may receive weaker corrective gradients during fine-tuning. |

**Flow-matching extras** (shown only for `flow_matching`):

| Parameter | Default | Description |
|---|---|---|
| FM min t | 0.01 | Minimum time value for the flow ODE — avoids numerical issues at t = 0 |
| FM num timesteps | 100 | Integration steps for the flow ODE at inference |
| FM self-condition | false | Enable self-conditioning: feed the model's previous prediction back as input |
| Use velocity | false | Parameterise the model output as a velocity field rather than a noise prediction |

---

### Regression settings

Applies to **regression** task family only. Trains a property predictor head on top of the molecular encoder, used later for CFG property steering.

| Parameter | Default | Description |
|---|---|---|
| Criterion | `mse` | Loss function: `mse` or `mae` |
| Metric | `mae` | Validation metric |
| Number of MLP layers | 3 | Depth of the property prediction head |
| MLP batch norm | `batchnorm` | Normalisation inside the MLP: `batchnorm`, `layernorm`, or `none` |
| MLP dropout | 0.2 | Dropout in the prediction head |
| Target normalization | true | Standardise property targets to zero mean and unit variance before training |

---

### SSL-3D settings

Applies to **ssl3d** task family only. Combines 3D coordinate denoising with masked atom-type prediction as a pre-training objective.

| Parameter | Default | Description |
|---|---|---|
| Denoise weight | 1 | Loss weight for the coordinate denoising term |
| Mask rate | 0.15 | Fraction of atoms whose type is masked and predicted |
| Mtype weight | 0.5 | Loss weight for the masked atom-type prediction term |
| Sigma min | 0.01 Å | Minimum noise standard deviation added to coordinates |
| Sigma max | 2.0 Å | Maximum noise standard deviation |
| Sigma schedule | `uniform` | Distribution for sampling sigma: `uniform` or `log_uniform` |

---

### VAE settings

Applies to **vae** task family only. Trains a variational autoencoder that encodes molecules into a continuous latent space.

| Parameter | Default | Description |
|---|---|---|
| Latent dim | 8 | Dimensionality of the VAE latent vector |
| Augment noise | 0.1 | Standard deviation of Gaussian noise added to coordinates during training augmentation |
| Augment rotation | true | Apply random 3D rotations to each molecule during training |

---

### Trainer

| Parameter | Default | Description |
|---|---|---|
| Optimizer | `adamw` | `adamw` or `adam` |
| Learning rate | 0.0002 | Initial LR |
| Weight decay | 1e-12 | L2 regularisation coefficient |
| Epochs | 200 | Total training epochs |
| Scheduler | `cosineannealing` | LR schedule: `cosineannealing`, `step`, or `none` |
| Validation interval | 3 | Epochs between validation runs |
| EMA decay | 0.9999 | Exponential moving average decay for model weights — EMA weights are used at inference |
| Precision | 32 | Floating-point precision: `32` (full) or `16` (mixed) |
| Save top-k | 3 | Number of best checkpoints to keep |
| Gradient clip mode | `norm` | `norm` (clip gradient norm) or `value` (clip element-wise) |
| Initial grad norm | 3000 | Target gradient norm for the first step, used to initialise the gradient scaler |
| Monitor mode | `max` | Whether to keep checkpoints with the highest (`max`) or lowest (`min`) monitored metric |

---

### Logger

| Parameter | Default | Description |
|---|---|---|
| Logger backend | `logging` | `logging` (console/file) or `wandb` (Weights & Biases) |
| Log interval | 2 | Steps between log writes |
| W&B project | *(empty)* | W&B project name (required when backend = wandb) |
| W&B entity | *(empty)* | W&B team or username (optional) |
| W&B run name | *(empty)* | Override the auto-generated run name |

---

### Engine

| Parameter | Default | Description |
|---|---|---|
| Engine type | `original` | Training engine variant — `original` is the standard implementation |
| Number of workers | 2 | DataLoader worker processes for prefetching |

---

## Dry mode output

After clicking **Generate YAML**, the rendered configuration appears in a read-only text area below the form. Two buttons are shown:

- **Copy command** — copies a ready-to-run shell command (`MolCraftDiff train --config <path>`) to the clipboard.
- **Download YAML** — saves the configuration as a `.yaml` file.


---

## Job history

Every submitted Run job appears in the right column. Each row shows the experiment name and a status badge (`queued / running / completed / failed / cancelled`).

Click a row to expand it. Three sub-tabs are available:

| Sub-tab | Contents |
|---|---|
| **LOG** | Live-tailing training log. Updates every 3 seconds while the job is running |
| **YAML** | The full training configuration used for this job |
| **INFO** | Job metadata (start time, output directory) and a suggested launch command with a **Copy** button |

### Actions

| Action | When available | What it does |
|---|---|---|
| **Stop** | Running jobs | Sends SIGTERM to the training process |
| **Clone to form** | Any job | Copies this job's configuration back into the form for re-use or editing |
| **Download YAML** | Any job | Saves this job's YAML configuration |
| **Delete** | Completed / failed / cancelled jobs | Removes the job record (training output files on disk are not deleted) |


---

## Configuration presets

The presets bar above the form works identically to the generation presets — see [Presets](generation/presets.md). Presets save the full form state and restore it in one click.
