# Frozen numerical laboratory contract v1

R1 reference freeze, 2026-09-08. These equations define research operations;
no production renderer imports them. Approval: orchestrator approved R0 commit
`8ce3742` for numerical work, keeping the 256 MiB image-storage envelope.

Standards basis: [BT.2100-3](https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2100-3-202502-I!!PDF-E.pdf),
Tables 2, 4 and 5; [CSS Color 4](https://www.w3.org/TR/css-color-4/#color-conversion-code),
conversion appendix. PQ is absolute display light. HLG first reconstructs scene
light, then applies a luminance-coupled display transform. The laboratory fixes
HLG peak at 1,000 cd/m², black at zero and gamma at 1.2. It does not implement
alternate viewing conditions, ICtCp, constant-luminance YCbCr or camera log.

## Transfer and gamut

Let `D(x)` be signed sRGB decoding: `x/12.92` when `abs(x) <= .04045`, otherwise
`sign(x)*((abs(x)+.055)/1.055)^2.4`. Encoding uses the inverse power branch for
`abs(x) > .0031308` and `12.92*x` otherwise. These standard rounded breakpoints
do not constitute an exactly continuous mathematical bijection.

PQ constants are exact rationals: `m1=2610/16384`, `m2=2523/32`,
`c1=3424/4096`, `c2=2413/128`, `c3=2392/128`. For signal `v` in [0,1],
`q=v^(1/m2)` and `L=10000*(max(q-c1,0)/(c2-c3*q))^(1/m1)`.
For luminance `L` in [0,10000], `p=(L/10000)^m1` and
`v=((c1+c2*p)/(1+c3*p))^m2`. Encoding zero has a small nonzero signal value;
the oracle must not force it to zero. Decoding signal zero is exactly black.

HLG uses `a=.17883277`, `b=1-4a`, `c=.5-a*ln(4a)` without rounding `c` again.
Scene component `s=v²/3` for `v<=.5`, otherwise `(exp((v-c)/a)+b)/12`.
Let `Y=.2627*sR+.6780*sG+.0593*sB`; display components are
`1000*Y^.2*sRGB`, with all-zero input returning zero. The published rounded
constant `a` gives a tiny white-endpoint deviation; preserve and measure it.
SDR video uses the explicit zero-black display model `L=whiteNits*v^2.4`.
This bounded BT.1886 case does not claim nonzero-black/reference-monitor support.

Derive RGB-to-XYZ matrices from each primary `(x,y)` column
`[x/y,1,(1-x-y)/y]`; solve column scales against white
`[.3127/.329,1,(1-.3127-.329)/.329]`. Rec.709 primaries are
`(.64,.33),(.30,.60),(.15,.06)`; P3 are `(.68,.32),(.265,.69),(.15,.06)`;
Rec.2020 are `(.708,.292),(.170,.797),(.131,.046)`. Conversion is
`inverse(Mdestination)*Msource*rgb`. Both white points are D65, so no adaptation.
The Decimal oracle uses pivoted Gaussian elimination. The separate JS candidate
uses cofactors/determinants. CSS's rational matrices are an external cross-check.

Source sRGB/P3 values decode before gamut conversion and multiply by
`sourceWhiteNits/203`; PQ/HLG display values divide by 203. Working RGB values
are linear BT.2020. RGB is never bounded to [0,1] at an intermediate step.
Explicit source alpha is dimensionless in [0,1]. Inputs must be finite and
working straight RGB must stay in [-64,64]; unsupported types fail explicitly.

The raw 10-bit range test maps limited `Y=(code-64)/876`,
`Cb=(code-512)/896`, `Cr=(code-512)/896`; full range uses 1023 for all divisors
and zero luma offset. For `Kr,Kb` = (.2126,.0722) or (.2627,.0593),
`R=Y+2*(1-Kr)*Cr`, `B=Y+2*(1-Kb)*Cb`, and `G=(Y-Kr*R-Kb*B)/(1-Kr-Kb)`.
These are individual collocated samples. Chroma resampling/location, encoded
transport and non-neutral clipping behavior need separate browser/codec proof.

## Composition and sampling

Associate a straight pixel `[r,g,b,a]` as `[a*r,a*g,a*b,a]`, with a=0 producing
all-zero associated values. Unassociate divides RGB by positive alpha only;
zero alpha returns all zeros. Source-over on associated four-vectors is
`source + destination*(1-sourceAlpha)`. A dissolve is
`(1-weight)*outgoing + weight*incoming` on complete associated vectors, followed
by source-over onto the lower composition once. Weights are exact rational
frame fractions in fixtures. Linear exposure multiplies associated RGB by
`2^stops`; coverage multiplies all four components. Their order commutes; a
nonlinear straight-color square does not commute with applying it to associated
color, which is a deliberate negative control.

Text uses fixed sRGB color plus an independent fixed coverage array; fill,
outline and background colors are converted separately before source-over.
These masks prove color/coverage only; they do not validate real font rasterization.

Lens fixtures use normalized output pixel centers, center (.5,.5), focal (1,1),
output scale 1, radial `1+k1*r²+k2*r⁴+k3*r⁶` and Brown-Conrady tangential
offsets `(2*p1*x*y+p2*(r²+2*x²), p1*(r²+2*y²)+2*p2*x*y)`.
Blend distorted coordinates by strength, restore center, then map to source
pixel-center coordinates `normalized*size-.5`. Bilinear interpolation samples
associated four-vectors; any out-of-image tap is transparent zero. Geometry
and color are returned separately, so a color tolerance cannot hide a wrong tap.

## Deliberately bounded SDR view and scope

The reference view is a testable technical shoulder, not a claim of a pleasing
grade or BT.2390/BT.2446 implementation. Compute working luminance
`y=.2627*r+.6780*g+.0593*b`. Map `T(y)=max(y,0)` for y<=.75;
above .75, `T(y)=.75+.25*(y-.75)/(y-.5)`. For positive luminance scale RGB
uniformly by `T(y)/y`, else use black. Convert to linear Rec.709, hard-clip
channels to [0,1], then sRGB encode. One working white maps to .875 of SDR
linear peak; the view's declared display peak is 100 cd/m². Signed gamut
clipping and reference-white compression are explicit limitations.

The scope consumes associated composited pixels over black before view mapping.
It reports luminance in nits using `203*(.2627*r+.6780*g+.0593*b)` and eleven
100-nit bins: floor(max(nits,0)/100), capped at bin 10. Peak values remain
uncapped. Exact bin-edge fixtures deliberately test whether precision loss
changes classification. This tiny sampled scope is not full-frame MaxCLL/MaxFALL.
Rational scope-fixture pixels and bin classification use exact fractions, so
Decimal rounding cannot incorrectly turn an exact 100-nit edge into the bin
below. Irrational input stages do not enter this exact discrete oracle.

## Frozen comparison limits and exclusions

Inputs, expected Decimal vectors and oracle hashes are committed before the
candidate is created or compared. Decimal precision is 60 significant digits.
Scalar comparisons pass at absolute error <=1e-10 **or** relative error <=1e-9;
record both. Discrete bins/reasons/metadata and raw code copies are exact.
RGBA16F storage sensitivity is a separate CPU experiment: quantize working
stage outputs to IEEE binary16, ties-to-even, then compare 10-bit output-code
values with a maximum error of 1 code. It is not Float32 shader arithmetic,
actual GPU storage, 10-bit transport or a codec qualification. Test the quantizer
against Python's independent `struct` half-float conversion on explicit values.
Candidate errors remain failures; do not regenerate goldens to match them.

Legacy source, codec output, live plugins, fonts, full scopes, GPU lens paths,
chroma sampling, actual HDR metadata transport, lifecycle and performance are
separate unqualified cells until their named later tests run.
