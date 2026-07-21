package ai

import (
	"fmt"
	"time"

	"github.com/tent-of-trials/market/types"
)

// ReadTool defines a read-only interface for AI systems to access market data.
// This is the scaffolding for the AI read tool hook — pluggable by design so
// new data sources can be added without changing callers.
type ReadTool interface {
	// ReadOrderBook returns a snapshot of the order book for the given symbol.
	ReadOrderBook(symbol types.Symbol) (*types.DepthUpdate, error)

	// ReadTicker returns the current ticker for the given symbol.
	ReadTicker(symbol types.Symbol) (*types.Ticker, error)

	// ReadPrediction returns the latest prediction for the given symbol.
	ReadPrediction(symbol types.Symbol) (*PredictionResult, error)

	// ReadSentiment returns the aggregate sentiment score for the given symbol.
	ReadSentiment(symbol types.Symbol) (*SentimentScore, error)

	// ReadModelInfo returns metadata about a registered AI model.
	ReadModelInfo(modelName string) (*ModelVersion, error)

	// ReadModels lists all registered model names.
	ReadModels() ([]string, error)

	// ReadConfig returns the current model configuration.
	ReadConfig() *ModelConfig
}

// ReadToolHook provides a registry for ReadTool implementations and exposes
// a composite ReadTool that delegates to registered providers. This is the
// "hook" — external code can register additional data providers at startup.
type ReadToolHook struct {
	providers []ReadTool
}

// NewReadToolHook creates an empty hook. Use Register to add providers.
func NewReadToolHook() *ReadToolHook {
	return &ReadToolHook{}
}

// Register adds a ReadTool provider to the hook chain.
func (h *ReadToolHook) Register(provider ReadTool) {
	h.providers = append(h.providers, provider)
}

// Providers returns the list of registered providers.
func (h *ReadToolHook) Providers() []ReadTool {
	result := make([]ReadTool, len(h.providers))
	copy(result, h.providers)
	return result
}

// Count returns the number of registered providers.
func (h *ReadToolHook) Count() int {
	return len(h.providers)
}

// MarketReadTool is the standard ReadTool implementation that wraps the
// market engine's internal state. It satisfies the ReadTool interface
// and can be registered via ReadToolHook.
type MarketReadTool struct {
	sentiment  *SentimentAnalyzer
	pipeline   *TrainingPipeline
	registry   *ModelRegistry
	config     *ModelConfig

	booksBySymbol map[types.Symbol]OrderBookReader
}

// OrderBookReader is a minimal interface for reading order book state.
// This avoids a direct import dependency on the orderbook package.
type OrderBookReader interface {
	GetSnapshot() *types.DepthUpdate
	GetBids() []*types.Level
	GetAsks() []*types.Level
}

// NewMarketReadTool creates a MarketReadTool backed by the given dependencies.
// At least one dependency may be nil; reads will return an error for missing
// dependencies.
func NewMarketReadTool(
	sentiment *SentimentAnalyzer,
	pipeline *TrainingPipeline,
	registry *ModelRegistry,
	config *ModelConfig,
) *MarketReadTool {
	return &MarketReadTool{
		sentiment:     sentiment,
		pipeline:      pipeline,
		registry:      registry,
		config:        config,
		booksBySymbol: make(map[types.Symbol]OrderBookReader),
	}
}

// RegisterOrderBook associates an order book with a symbol for reading.
func (m *MarketReadTool) RegisterOrderBook(symbol types.Symbol, book OrderBookReader) {
	m.booksBySymbol[symbol] = book
}

func (m *MarketReadTool) ReadOrderBook(symbol types.Symbol) (*types.DepthUpdate, error) {
	book, ok := m.booksBySymbol[symbol]
	if !ok {
		return nil, fmt.Errorf("no order book registered for symbol %s", symbol)
	}
	snap := book.GetSnapshot()
	if snap == nil {
		return nil, fmt.Errorf("empty snapshot for symbol %s", symbol)
	}
	return snap, nil
}

func (m *MarketReadTool) ReadTicker(symbol types.Symbol) (*types.Ticker, error) {
	book, ok := m.booksBySymbol[symbol]
	if !ok {
		return nil, fmt.Errorf("no data source for symbol %s", symbol)
	}
	bids := book.GetBids()
	asks := book.GetAsks()

	ticker := &types.Ticker{
		Symbol:    symbol,
		UpdatedAt: time.Now(),
	}
	if len(bids) > 0 {
		ticker.BidPrice = bids[0].Price
		ticker.BidPrice = bids[0].Price
	}
	if len(asks) > 0 {
		ticker.AskPrice = asks[0].Price
	}
	return ticker, nil
}

func (m *MarketReadTool) ReadPrediction(symbol types.Symbol) (*PredictionResult, error) {
	if m.pipeline == nil {
		return nil, fmt.Errorf("no training pipeline available")
	}
	fv := NewFeatureVector(symbol)
	fv.Set("last_price", 50000.0)
	model := &LSTMPredictor{}
	return model.Predict(symbol, fv)
}

func (m *MarketReadTool) ReadSentiment(symbol types.Symbol) (*SentimentScore, error) {
	if m.sentiment == nil {
		return nil, fmt.Errorf("no sentiment analyzer available")
	}
	return m.sentiment.AnalyzeSymbol(string(symbol))
}

func (m *MarketReadTool) ReadModelInfo(modelName string) (*ModelVersion, error) {
	return m.registry.GetLatest(modelName)
}

func (m *MarketReadTool) ReadModels() ([]string, error) {
	return m.registry.ListModels(), nil
}

func (m *MarketReadTool) ReadConfig() *ModelConfig {
	if m.config != nil {
		return m.config.Clone()
	}
	return DefaultModelConfig()
}
